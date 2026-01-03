import Challenge from '../models/Challenge';
import { IChallenge } from '../types/models';
import UserChallenge from '../models/UserChallenge';
import { NotificationService } from './notificationService';
import { GamificationService } from './gamificationService';
import { AppError } from '../middleware/errorHandler';
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

    // If it's a 52-week style challenge (detected by duration or custom flag)
    if (challenge.durationDays >= 364) {
      // Determine level (100, 200, 500, 1000) from title or metadata
      let increment = 100;
      if (challenge.title.includes('200')) increment = 200;
      if (challenge.title.includes('500')) increment = 500;
      if (challenge.title.includes('1000')) increment = 1000;

      const weeks = [];
      for (let i = 1; i <= 52; i++) {
        weeks.push({
          weekNumber: i,
          targetAmount: i * increment,
          savedAmount: 0,
          status: 'pending',
        });
      }
      userChallenge.weeks = weeks as any;
      userChallenge.flexibility = {
        skipsUsed: 0,
        skipsMax: 3,
        postponementsUsed: 0,
        postponementsMax: 2,
      };
    }

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
      userChallenge.progress = Math.min(100, (userChallenge.currentValue / target) * 100);
      if (userChallenge.progress >= 100) {
        userChallenge.status = 'completed';
        userChallenge.completedAt = new Date();

        // Send notification
        NotificationService.sendToUser(userChallenge.userId.toString(), {
          title: 'Challenge Réussi ! 🏆',
          body: `Bravo ! Tu as terminé le challenge : ${userChallenge.challengeId.title}`,
          data: { type: 'challenge_completed', userChallengeId: userChallenge._id.toString() },
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

  static async validateWeek(userChallengeId: string, weekNumber: number, amount: number) {
    const userChallenge = await UserChallenge.findById(userChallengeId).populate<{
      challengeId: IChallenge;
    }>('challengeId');
    if (!userChallenge) throw new AppError('Participation non trouvée', 404);

    const week = userChallenge.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);

    if (week.status === 'completed') throw new AppError('Semaine déjà validée', 400);

    week.savedAmount = amount;
    week.status = 'completed';
    week.validatedAt = new Date();

    userChallenge.currentValue += amount;
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
      await GamificationService.addXP(userChallenge.userId.toString(), userChallenge.challengeId.rewardPoints || 500);
      await GamificationService.awardBadge(
        userChallenge.userId.toString(),
        `Champion: ${userChallenge.challengeId.title}`,
        userChallenge.challengeId.icon || '🏆'
      );

      NotificationService.sendToUser(userChallenge.userId.toString(), {
        title: 'Challenge Réussi ! 🏆',
        body: `Bravo ! Tu as terminé le challenge : ${userChallenge.challengeId.title}`,
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
      logger.info('Seed challenges created');
    }
  }
}
