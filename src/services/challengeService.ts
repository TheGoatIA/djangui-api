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
          status: 'pending',
        });
      }
    }

    return UserChallenge.create({
      userId,
      challengeId,
      endDate,
      weeks,
      status: 'active',
    });
  }

  /**
   * Quitter un challenge
   */
  static async unjoinChallenge(userChallengeId: string, userId: string) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

    // Si le challenge contient de l'argent, on rembourse avant de supprimer
    if (uc.currentValue > 0) {
      let fees = 0;
      // Pénalité de 0.5% si le challenge n'est pas "completed" ou "redeemed"
      if (!['completed', 'redeemed'].includes(uc.status)) {
        fees = uc.currentValue * 0.005;
      }

      await WalletService.executeTransaction({
        userId,
        amount: uc.currentValue,
        fees,
        type: 'deposit',
        description: `Remboursement (Quitter Challenge) : ${userChallengeId}`,
        paymentMethod: 'wallet',
        metadata: { userChallengeId, action: 'unjoin_refund', penaltyApplied: fees > 0 },
      });
    }

    await UserChallenge.findByIdAndDelete(userChallengeId);
    return true;
  }
  /**
   * Permet à un utilisateur de déposer de l'argent réel pour valider une étape de challenge (ex: épargne).
   */
  static async addChallengeDeposit(
    userId: string,
    userChallengeId: string,
    weekNumber: number,
    amount: number,
  ) {
    const userChallenge = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!userChallenge) throw new AppError('Challenge utilisateur non trouvé ou non autorisé', 404);

    const week = userChallenge.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);

    // 1. Débiter le wallet (Argent Réel)
    const transaction = await WalletService.executeTransaction({
      userId,
      amount,
      type: 'saving_transfer',
      description: `Dépôt pour le challenge : Semaine ${weekNumber}`,
      paymentMethod: 'wallet',
      metadata: { userChallengeId, weekNumber },
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
   * Valide une semaine de challenge avec une preuve optionnelle
   */
  static async validateWeek(
    userId: string,
    userChallengeId: string,
    weekNumber: number,
    data?: { proofImageUrl?: string; note?: string; amount?: number },
  ) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId }).populate('challengeId');
    if (!uc)
      throw new AppError('Challenge non trouvé ou non autorisé', 404);

    const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);

    const challenge = uc.challengeId as any;

    // Si c'est un challenge d'épargne, on effectue le transfert réel
    if (challenge.type === 'saving' && week.status !== 'completed') {
      const amountToWithdraw = data?.amount || week.targetAmount;
      if (amountToWithdraw <= 0) throw new AppError('Montant de dépôt invalide', 400);

      const transaction = await WalletService.executeTransaction({
        userId,
        amount: amountToWithdraw,
        type: 'saving_transfer',
        description: `Validation Challenge : ${challenge.title} - Semaine ${weekNumber}`,
        paymentMethod: 'wallet',
        metadata: { userChallengeId, weekNumber },
      });

      week.savedAmount += amountToWithdraw;
      week.transactionId = transaction.reference;
      uc.currentValue += amountToWithdraw;
    }

    week.status = 'completed';
    week.validatedAt = new Date();
    if (data?.proofImageUrl) week.proofImageUrl = data.proofImageUrl;
    if (data?.note) week.verificationNote = data.note;

    // Mise à jour de la progression globale
    const completedWeeks = uc.weeks.filter((w) => w.status === 'completed').length;
    uc.progress = Math.round((completedWeeks / uc.weeks.length) * 100);

    if (uc.progress >= 100) {
      uc.status = 'completed';
      uc.completedAt = new Date();
      await GamificationService.awardChallengeCompletion(userId, 'Challenge Réussi');
    }

    await uc.save();
    return uc;
  }

  /**
   * Récupère les fonds accumulés dans un challenge terminé
   */
  static async redeemChallenge(userId: string, userChallengeId: string) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

    if (uc.status !== 'completed' && uc.progress < 100) {
      throw new AppError('Le challenge doit être terminé pour récupérer les fonds', 400);
    }

    if (uc.currentValue <= 0) {
      throw new AppError('Aucun fond à récupérer (solde nul)', 400);
    }

    // Transfert vers le wallet principal
    await WalletService.executeTransaction({
      userId,
      amount: uc.currentValue,
      type: 'challenge_reward',
      description: `Remboursement Challenge : ${userChallengeId}`,
      paymentMethod: 'wallet',
    });

    const redeemedAmount = uc.currentValue;
    uc.currentValue = 0;
    uc.status = 'redeemed';
    await uc.save();

    return { redeemedAmount, userChallenge: uc };
  }

  /**
   * Reporte une semaine de challenge
   */
  static async postponeWeek(userId: string, userChallengeId: string, weekNumber: number) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc)
      throw new AppError('Challenge non trouvé ou non autorisé', 404);

    if (uc.flexibility.postponementsUsed >= uc.flexibility.postponementsMax) {
      throw new AppError('Limite de reports atteinte pour ce challenge', 400);
    }

    const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);
    if (week.status !== 'pending') throw new AppError('Seule une semaine en attente peut être reportée', 400);

    week.status = 'postponed';
    uc.flexibility.postponementsUsed += 1;

    // On rallonge la date de fin de 7 jours
    uc.endDate = new Date(uc.endDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    await uc.save();
    return uc;
  }

  /**
   * Saute une semaine de challenge
   */
  static async skipWeek(userId: string, userChallengeId: string, weekNumber: number) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc)
      throw new AppError('Challenge non trouvé ou non autorisé', 404);

    if (uc.flexibility.skipsUsed >= uc.flexibility.skipsMax) {
      throw new AppError('Limite de "skips" atteinte pour ce challenge', 400);
    }

    const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);
    if (week.status !== 'pending') throw new AppError('Seule une semaine en attente peut être sautée', 400);

    week.status = 'skipped';
    uc.flexibility.skipsUsed += 1;

    // Mise à jour de la progression (considéré comme "fait" mais sans gain)
    const processedWeeks = uc.weeks.filter((w) => ['completed', 'skipped'].includes(w.status)).length;
    uc.progress = Math.round((processedWeeks / uc.weeks.length) * 100);

    await uc.save();
    return uc;
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
        'Challenge Réussi',
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
          icon: '🛡️',
        },
        {
          title: 'Défi Tontineur Pro',
          description: 'Ne ratez aucune cotisation pendant 3 mois.',
          type: 'habit',
          durationDays: 90,
          difficulty: 'medium',
          rewardPoints: 1000,
          icon: '💎',
        },
        {
          title: 'Zéro Dépense Inutile',
          description: 'Réduisez vos dépenses de divertissement de 20% ce mois-ci.',
          type: 'spending_cut',
          durationDays: 30,
          difficulty: 'hard',
          rewardPoints: 1500,
          icon: '📉',
        },
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
