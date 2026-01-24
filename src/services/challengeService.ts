import Challenge from '../models/Challenge';
import { IChallenge } from '../types/models';
import UserChallenge from '../models/UserChallenge';
import { NotificationService } from './notificationService';
import { GamificationService } from './gamificationService';
import { AppError } from '../middleware/errorHandler';
import { OCRService } from './ai/ocrService';
import logger from '../utils/logger';

export class ChallengeService {
  static async getAllChallenges() {
    return Challenge.find({ isCustom: false }).sort({ difficulty: 1 });
  }

  static async getUserChallenges(userId: string) {
    return UserChallenge.find({ userId }).populate('challengeId').sort({ createdAt: -1 });
  }

  static async joinChallenge(userId: string, challengeId: string) {
    const challenge = await Challenge.findById(challengeId);
    if (!challenge) throw new AppError('Challenge not found', 404);

    const existing = await UserChallenge.findOne({ userId, challengeId, status: 'active' });
    if (existing) throw new AppError('Challenge already active for this user', 400);

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(startDate.getDate() + challenge.durationDays);

    const userChallenge = new UserChallenge({
      userId,
      challengeId,
      startDate,
      endDate,
    });

    // Generate weeks for ALL challenges
    const totalWeeks = Math.max(1, Math.ceil(challenge.durationDays / 7));
    const weeks = [];

    // If it is a 52-week style challenge (long duration)
    const isIncremental = challenge.durationDays >= 364;
    let increment = 0;
    if (isIncremental) {
      increment = 100;
      if (challenge.title.includes('200')) increment = 200;
      if (challenge.title.includes('500')) increment = 500;
      if (challenge.title.includes('1000')) increment = 1000;
    }

    const weeklyTarget = challenge.targetAmount
      ? Math.floor(challenge.targetAmount / totalWeeks)
      : 0;

    for (let i = 1; i <= totalWeeks; i++) {
      weeks.push({
        weekNumber: i,
        targetAmount: isIncremental ? i * increment : weeklyTarget,
        savedAmount: 0,
        status: 'pending',
      });
    }
    userChallenge.weeks = weeks as any;

    // Set flexibility
    userChallenge.flexibility = {
      skipsUsed: 0,
      skipsMax: isIncremental ? 3 : 1,
      postponementsUsed: 0,
      postponementsMax: isIncremental ? 2 : 1,
    };

    await userChallenge.save();
    return userChallenge;
  }

  static async updateProgress(userChallengeId: string, value: number) {
    const userChallenge = await UserChallenge.findById(userChallengeId).populate<{
      challengeId: IChallenge;
    }>('challengeId');
    if (!userChallenge) throw new AppError('User challenge participation not found', 404);
    if (userChallenge.status !== 'active') return userChallenge;

    userChallenge.currentValue += value;

    const target = userChallenge.challengeId.targetAmount || 0;
    if (target > 0) {
      const oldProgress = userChallenge.progress;
      userChallenge.progress = Math.min(100, (userChallenge.currentValue / target) * 100);

      if (userChallenge.progress >= 100) {
        userChallenge.status = 'completed';
        userChallenge.completedAt = new Date();

        // Send notification
        NotificationService.sendToUser(userChallenge.userId.toString(), {
          title: '',
          body: '',
          translationKey: 'CHALLENGE_COMPLETED',
          translationData: { challengeTitle: userChallenge.challengeId.title },
          data: { type: 'challenge_completed', userChallengeId: userChallenge._id.toString() },
        });
      } else if (userChallenge.progress >= 50 && oldProgress < 50) {
        // Milestone: 50%
        NotificationService.sendToUser(userChallenge.userId.toString(), {
          title: '',
          body: '',
          translationKey: 'CHALLENGE_MILESTONE_50',
          translationData: { challengeTitle: userChallenge.challengeId.title },
          data: {
            type: 'challenge_milestone',
            userChallengeId: userChallenge._id.toString(),
            progress: '50',
          },
        });
      }
    }

    await userChallenge.save();

    // Add XP for progress
    if (value > 0) {
      const xpAmount = Math.floor(value / 100); // 1 XP per 100 XAF saved
      if (xpAmount > 0) {
        await GamificationService.addXP(userChallenge.userId.toString(), xpAmount);
      }
    }

    return userChallenge;
  }

  static async validateWeek(
    userChallengeId: string,
    weekNumber: number,
    amount: number,
    proofFilePath?: string,
  ) {
    const userChallenge = await UserChallenge.findById(userChallengeId).populate<{
      challengeId: IChallenge;
    }>('challengeId');
    if (!userChallenge) throw new AppError('Participation non trouvée', 404);

    // Lazy initialization of weeks for older participations
    if (userChallenge.weeks.length === 0) {
      const totalWeeks = Math.max(1, Math.ceil(userChallenge.challengeId.durationDays / 7));
      const weeklyTarget = userChallenge.challengeId.targetAmount
        ? Math.floor(userChallenge.challengeId.targetAmount / totalWeeks)
        : 0;

      for (let i = 1; i <= totalWeeks; i++) {
        userChallenge.weeks.push({
          weekNumber: i,
          targetAmount: weeklyTarget,
          savedAmount: 0,
          status: 'pending',
        } as any);
      }
      await userChallenge.save();
    }

    const week = userChallenge.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);

    if (week.status === 'completed') throw new AppError('Semaine déjà validée', 400);

    let finalAmount = amount;

    // AI Verification if proof is provided
    if (proofFilePath) {
      const ocrResult = await OCRService.verifyChallengeProof(proofFilePath);

      // 0. Is it a receipt?
      if (!ocrResult.isReceipt) {
        await GamificationService.deductXP(
          userChallenge.userId.toString(),
          50,
          'Tentative de validation avec une image invalide.',
        );
        throw new AppError(
          "L'image fournie n'est pas reconnue comme un reçu de transaction valide.",
          400,
        );
      }

      // 1. Transaction Uniqueness
      if (ocrResult.transactionId) {
        const existingTransaction = await UserChallenge.findOne({
          'weeks.transactionId': ocrResult.transactionId,
        });
        if (existingTransaction) {
          await GamificationService.deductXP(
            userChallenge.userId.toString(),
            100,
            "Tentative de fraude (réutilisation d'un ID de transaction).",
          );
          throw new AppError('Cette transaction a déjà été utilisée comme preuve.', 400);
        }
      }

      // 2. Amount Check (Fuzzy)
      const target = week.targetAmount;
      if (ocrResult.amount < target) {
        throw new AppError(
          `Le montant détecté (${ocrResult.amount} XAF) est inférieur au montant cible (${target} XAF).`,
          400,
        );
      }

      // 3. Date check (Simple: not more than 10 days old)
      const now = new Date();
      const transDate = ocrResult.date || now;
      const diffDays = Math.abs(now.getTime() - transDate.getTime()) / (1000 * 3600 * 24);
      if (diffDays > 10) {
        throw new AppError('La transaction est trop ancienne pour valider cette semaine.', 400);
      }

      finalAmount = ocrResult.amount;
      week.proofImageUrl = proofFilePath;
      week.transactionId = ocrResult.transactionId;
      week.transactionDate = ocrResult.date;
      week.verificationStatus = 'verified';
    }

    week.savedAmount = finalAmount;
    week.status = 'completed';
    week.validatedAt = new Date();

    userChallenge.currentValue += finalAmount;
    const target = userChallenge.challengeId.targetAmount || 0;
    if (target > 0) {
      userChallenge.progress = Math.min(100, (userChallenge.currentValue / target) * 100);
    }

    // Award bonus XP for weekly validation
    await GamificationService.addXP(userChallenge.userId.toString(), 50);

    if (userChallenge.progress >= 100) {
      userChallenge.status = 'completed';
      userChallenge.completedAt = new Date();

      // Award big XP and Badge
      await GamificationService.addXP(
        userChallenge.userId.toString(),
        userChallenge.challengeId.rewardPoints || 500,
      );
      await GamificationService.awardBadge(
        userChallenge.userId.toString(),
        `Champion: ${userChallenge.challengeId.title}`,
        userChallenge.challengeId.icon || '🏆',
      );

      NotificationService.sendToUser(userChallenge.userId.toString(), {
        title: '',
        body: '',
        translationKey: 'CHALLENGE_COMPLETED',
        translationData: { challengeTitle: userChallenge.challengeId.title },
        data: { type: 'challenge_completed', userChallengeId: userChallenge._id.toString() },
      });
    }

    await userChallenge.save();
    return userChallenge;
  }

  // Helper to create seed challenges if none exist
  static async seedChallenges() {
    const count = await Challenge.countDocuments();
    if (count === 0) {
      await Challenge.create([
        {
          title: 'Sans Café (30 jours)',
          description: "Économise l'argent de tes cafés quotidiens pendant un mois.",
          type: 'spending_cut',
          difficulty: 'medium',
          durationDays: 30,
          rewardPoints: 50,
          icon: '☕',
        },
        {
          title: 'Premier Pas',
          description: 'Épargne tes premiers 5 000 XAF.',
          type: 'saving',
          difficulty: 'easy',
          targetAmount: 5000,
          durationDays: 7,
          rewardPoints: 20,
          icon: '🌱',
        },
        {
          title: "Champion de l'Épargne",
          description: 'Épargne 50 000 XAF ce mois-ci.',
          type: 'saving',
          difficulty: 'hard',
          targetAmount: 50000,
          durationDays: 30,
          rewardPoints: 200,
          icon: '💎',
        },
      ]);
      logger.info('Basic seed challenges created');
    }

    // Check specifically for the 52-week challenge and add it if missing
    const tontineChallenge = await Challenge.findOne({
      title: 'Challenge 52 Semaines (1000F)',
    });
    if (!tontineChallenge) {
      await Challenge.create({
        title: 'Challenge 52 Semaines (1000F)',
        description:
          'Un défi progressif sur un an : commence par 1000F, puis ajoute 1000F chaque semaine (Semaine 52 = 52 000F). Total : 1 378 000 XAF !',
        type: 'saving',
        difficulty: 'hard',
        targetAmount: 1378000,
        durationDays: 365,
        rewardPoints: 1000,
        icon: '🚀',
      });
      logger.info('52-Week 1000F Challenge created');
    }
  }

  static async unjoinChallenge(userChallengeId: string, userId: string) {
    const userChallenge = await UserChallenge.findOneAndDelete({
      _id: userChallengeId,
      userId,
    });

    if (!userChallenge) {
      throw new AppError('Participation not found', 404);
    }

    return true;
  }
}
