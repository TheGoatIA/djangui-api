import UserChallenge from '../models/UserChallenge';
import Challenge from '../models/Challenge';
import { WalletService } from './walletService';
import { GamificationService } from './gamificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class ChallengeService {
  /**
   * Liste tous les challenges disponibles
   */
  static async getAllChallenges() {
    return Challenge.find().sort({ createdAt: -1 });
  }

  /**
   * Liste les challenges d'un utilisateur
   */
  static async getUserChallenges(userId: string) {
    return UserChallenge.find({ userId }).populate('challengeId').sort({ createdAt: -1 });
  }

  /**
   * Rejoindre un challenge
   */
  static async joinChallenge(userId: string, challengeId: string) {
    const challenge = await Challenge.findById(challengeId);
    if (!challenge) throw new AppError('Challenge non trouvé', 404);

    const existing = await UserChallenge.findOne({ userId, challengeId, status: 'active' });
    if (existing) throw new AppError('Vous participez déjà à ce challenge', 400);

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + challenge.durationDays);

    // Initialisation des semaines si c'est un challenge d'épargne
    const weeks = [];
    if (challenge.type === 'saving') {
      const numWeeks = Math.ceil(challenge.durationDays / 7);
      const amountPerWeek = (challenge.targetAmount || 0) / numWeeks;
      for (let i = 1; i <= numWeeks; i++) {
        weeks.push({
          weekNumber: i,
          targetAmount: amountPerWeek,
          savedAmount: 0,
          status: 'pending'
        });
      }
    }

    return UserChallenge.create({
      userId,
      challengeId,
      endDate,
      weeks,
      status: 'active'
    });
  }

  /**
   * Quitter un challenge
   */
  static async unjoinChallenge(userChallengeId: string, userId: string) {
    const uc = await UserChallenge.findOneAndDelete({ _id: userChallengeId, userId });
    if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);
    return true;
  }
  /**
   * Permet à un utilisateur de déposer de l'argent réel pour valider une étape de challenge (ex: épargne).
   */
  static async addChallengeDeposit(userId: string, userChallengeId: string, weekNumber: number, amount: number) {
    const userChallenge = await UserChallenge.findById(userChallengeId);
    if (!userChallenge) throw new AppError('Challenge utilisateur non trouvé', 404);
    if (userChallenge.userId.toString() !== userId) throw new AppError('Non autorisé', 403);

    const week = userChallenge.weeks.find(w => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);

    // 1. Débiter le wallet (Argent Réel)
    const transaction = await WalletService.executeTransaction({
      userId,
      amount,
      type: 'saving_transfer',
      description: `Dépôt pour le challenge : Semaine ${weekNumber}`,
      paymentMethod: 'wallet',
      metadata: { userChallengeId, weekNumber }
    });

    // 2. Mettre à jour l'état du challenge (Dépôt réel)
    week.savedAmount += amount;
    if (week.savedAmount >= week.targetAmount) {
      week.status = 'completed';
      week.validatedAt = new Date();
    }
    week.transactionId = transaction.reference;

    userChallenge.currentValue += amount;
    await userChallenge.save();

    return userChallenge;
  }

  /**
   * Traite la fin d'un challenge (Succès ou Échec)
   */
  static async resolveChallenge(userChallengeId: string, result: 'success' | 'failure') {
    const userChallenge = await UserChallenge.findById(userChallengeId);
    if (!userChallenge || userChallenge.status !== 'active') return;

    if (result === 'success') {
      userChallenge.status = 'completed';
      userChallenge.completedAt = new Date();

      // Gamification : Points et Badges
      await GamificationService.awardChallengeCompletion(
        userChallenge.userId.toString(),
        'Challenge Réussi'
      );
    } else {
      userChallenge.status = 'failed';
    }

    await userChallenge.save();
  }

  /**
   * Initialise les challenges de base si la collection est vide.
   */
  static async seedChallenges() {
    try {
      const count = await Challenge.countDocuments();
      if (count > 0) return;

      const initialChallenges = [
        {
          title: 'Épargne de Secours',
          description: 'Épargnez 50 000 XAF en 4 semaines pour parer aux imprévus.',
          type: 'saving',
          targetAmount: 50000,
          durationDays: 28,
          difficulty: 'easy',
          rewardPoints: 500,
          icon: '🛡️'
        },
        {
          title: 'Défi Tontineur Pro',
          description: 'Ne ratez aucune cotisation pendant 3 mois.',
          type: 'habit',
          durationDays: 90,
          difficulty: 'medium',
          rewardPoints: 1000,
          icon: '💎'
        },
        {
          title: 'Zéro Dépense Inutile',
          description: 'Réduisez vos dépenses de divertissement de 20% ce mois-ci.',
          type: 'spending_cut',
          durationDays: 30,
          difficulty: 'hard',
          rewardPoints: 1500,
          icon: '📉'
        }
      ];

      await Challenge.insertMany(initialChallenges);
      logger.info('[Seed] Challenges de base créés avec succès.');
    } catch (error: any) {
      logger.error(`[Seed] Erreur lors du seeding des challenges : ${error.message}`);
    }
  }

  /**
   * Met à jour la progression d'un challenge utilisateur.
   */
  static async updateProgress(userChallengeId: string, amount: number) {
    const userChallenge = await UserChallenge.findById(userChallengeId);
    if (!userChallenge) return;

    userChallenge.progress = Math.min(100, userChallenge.progress + amount);
    userChallenge.currentValue += amount;

    if (userChallenge.progress >= 100 && userChallenge.status === 'active') {
      await this.resolveChallenge(userChallengeId, 'success');
    } else {
      await userChallenge.save();
    }
  }
}
