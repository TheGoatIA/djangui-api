import UserChallenge from '../models/UserChallenge';
import Challenge from '../models/Challenge';
import { WalletService } from './walletService';
import { GamificationService } from './gamificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';

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

    const created = await UserChallenge.create({
      userId,
      challengeId,
      endDate,
      weeks,
      status: 'active',
    });

    MonitoringService.recordChallengeEvent('join', challenge.type);
    return created;
  }

  /**
   * Quitter un challenge
   */
  static async unjoinChallenge(userChallengeId: string, userId: string) {
    const transaction = await WalletService.runInTransaction(async (session) => {
      const uc = await UserChallenge.findOne({ _id: userChallengeId, userId }).session(session);
      if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

      // Si le challenge contient de l'argent, on rembourse avant de supprimer
      let tx: any = null;
      if (uc.currentValue > 0) {
        let fees = 0;
        // Pénalité de 0.5% si le challenge n'est pas "completed" ou "redeemed"
        if (!['completed', 'redeemed'].includes(uc.status)) {
          fees = uc.currentValue * 0.005;
        }

        tx = await WalletService.executeTransaction(
          {
            userId,
            amount: uc.currentValue,
            fees,
            type: 'deposit',
            description: `Remboursement (Quitter Challenge) : ${userChallengeId}`,
            paymentMethod: 'wallet',
            metadata: { userChallengeId, action: 'unjoin_refund', penaltyApplied: fees > 0 },
          },
          { session },
        );
      }

      await UserChallenge.findByIdAndDelete(userChallengeId, { session });
      return tx;
    });

    transaction?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordChallengeEvent('unjoin', 'unknown');
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
    const result = await WalletService.runInTransaction(async (session) => {
      const userChallenge = await UserChallenge.findOne({ _id: userChallengeId, userId }).session(
        session,
      );
      if (!userChallenge)
        throw new AppError('Challenge utilisateur non trouvé ou non autorisé', 404);

      if (userChallenge.status !== 'active')
        throw new AppError('Ce challenge n\'est plus actif', 400);
      if (userChallenge.endDate < new Date())
        throw new AppError('Ce challenge est expiré', 400);

      const week = userChallenge.weeks.find((w) => w.weekNumber === weekNumber);
      if (!week) throw new AppError('Semaine non trouvée', 404);

      // 1. Débiter le wallet (Argent Réel)
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount,
          type: 'saving_transfer',
          category: 'challenge_stake',
          description: `Dépôt pour le challenge : Semaine ${weekNumber}`,
          paymentMethod: 'wallet',
          metadata: { userChallengeId, weekNumber },
        },
        { session },
      );

      // 2. Mettre à jour l'état du challenge (Dépôt réel), dans la même transaction
      week.savedAmount += amount;
      if (week.savedAmount >= week.targetAmount) {
        week.status = 'completed';
        week.validatedAt = new Date();
      }
      week.transactionId = transaction.reference;

      userChallenge.currentValue += amount;
      await userChallenge.save({ session });

      return { userChallenge, transaction };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordChallengeEvent('deposit', 'saving');
    return result.userChallenge;
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
    const result = await WalletService.runInTransaction(async (session) => {
      const uc = await UserChallenge.findOne({ _id: userChallengeId, userId })
        .populate('challengeId')
        .session(session);
      if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);
      if (uc.status !== 'active') throw new AppError('Ce challenge n\'est plus actif', 400);
      if (uc.endDate < new Date()) throw new AppError('Ce challenge est expiré', 400);

      const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
      if (!week) throw new AppError('Semaine non trouvée', 404);

      const challenge = uc.challengeId as any;
      if (!challenge) {
        // Le modèle Challenge référencé a été supprimé (admin) entre-temps —
        // sans ce garde-fou, `challenge.type` ci-dessous lève un TypeError brut.
        throw new AppError(
          "Ce défi n'existe plus et ne peut plus être validé. Contactez le support.",
          410,
        );
      }
      let transaction: any = null;

      // Si c'est un challenge d'épargne, on effectue le transfert réel
      if (challenge.type === 'saving' && week.status !== 'completed') {
        // Ne débiter que le reliquat, pas le montant cible complet : si l'utilisateur
        // a déjà partiellement financé la semaine via addChallengeDeposit, utiliser
        // week.targetAmount ici le débiterait une seconde fois pour le montant total.
        const remaining = Math.max(0, week.targetAmount - week.savedAmount);
        const amountToWithdraw = data?.amount ?? remaining;
        if (amountToWithdraw < 0) throw new AppError('Montant de dépôt invalide', 400);

        if (amountToWithdraw > 0) {
          transaction = await WalletService.executeTransaction(
            {
              userId,
              amount: amountToWithdraw,
              type: 'saving_transfer',
          category: 'challenge_stake',
              description: `Validation Challenge : ${challenge.title} - Semaine ${weekNumber}`,
              paymentMethod: 'wallet',
              metadata: { userChallengeId, weekNumber },
            },
            { session },
          );

          week.savedAmount += amountToWithdraw;
          week.transactionId = transaction.reference;
          uc.currentValue += amountToWithdraw;
        }

        // Fintech : une semaine d'épargne n'est "complétée" que si le montant
        // cible est effectivement atteint — sinon un appel avec amount:0 (ou un
        // dépôt partiel) validait la semaine sans que l'argent soit réellement
        // épargné, contournant tout l'objectif du défi. Cohérent avec la même
        // condition déjà appliquée dans addChallengeDeposit ci-dessus.
        if (week.savedAmount < week.targetAmount) {
          throw new AppError(
            `Montant insuffisant pour valider cette semaine : il manque ${(
              week.targetAmount - week.savedAmount
            ).toLocaleString()} pour atteindre l'objectif.`,
            400,
          );
        }
      }

      week.status = 'completed';
      week.validatedAt = new Date();
      if (data?.proofImageUrl) week.proofImageUrl = data.proofImageUrl;
      if (data?.note) week.verificationNote = data.note;

      // Mise à jour de la progression globale
      const completedWeeks = uc.weeks.filter((w) => w.status === 'completed').length;
      uc.progress = Math.round((completedWeeks / uc.weeks.length) * 100);

      const shouldAwardCompletion = uc.progress >= 100;
      if (shouldAwardCompletion) {
        uc.status = 'completed';
        uc.completedAt = new Date();
      }

      await uc.save({ session });

      return { uc, transaction, shouldAwardCompletion };
    });

    result.transaction?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    // Gamification : effet secondaire non-critique, hors transaction. Une
    // erreur ici ne doit pas annuler la validation de la semaine déjà actée.
    if (result.shouldAwardCompletion) {
      GamificationService.awardChallengeCompletion(userId, 'Challenge Réussi').catch((err: any) =>
        logger.error(`Gamification award error: ${err.message}`),
      );
    }

    MonitoringService.recordChallengeEvent(
      'validate_week',
      (result.uc.challengeId as any)?.type || 'unknown',
      result.shouldAwardCompletion ? 'completed' : 'in_progress',
    );

    return result.uc;
  }

  /**
   * Récupère les fonds accumulés dans un challenge terminé
   */
  static async redeemChallenge(userId: string, userChallengeId: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const uc = await UserChallenge.findOne({ _id: userChallengeId, userId }).session(session);
      if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

      if (uc.status !== 'completed' && uc.progress < 100) {
        throw new AppError('Le challenge doit être terminé pour récupérer les fonds', 400);
      }

      if (uc.currentValue <= 0) {
        throw new AppError('Aucun fond à récupérer (solde nul)', 400);
      }

      const redeemedAmount = uc.currentValue;

      // Transfert vers le wallet principal, dans la même transaction que le
      // marquage "redeemed" pour éviter un double crédit si l'un des deux
      // écrit sans que l'autre persiste.
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount: redeemedAmount,
          type: 'challenge_reward',
          description: `Remboursement Challenge : ${userChallengeId}`,
          paymentMethod: 'wallet',
        },
        { session },
      );

      uc.currentValue = 0;
      uc.status = 'redeemed';
      await uc.save({ session });

      return { redeemedAmount, userChallenge: uc, transaction };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordChallengeEvent('redeem', 'unknown');
    return { redeemedAmount: result.redeemedAmount, userChallenge: result.userChallenge };
  }

  /**
   * Reporte une semaine de challenge
   */
  static async postponeWeek(userId: string, userChallengeId: string, weekNumber: number) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

    if (uc.flexibility.postponementsUsed >= uc.flexibility.postponementsMax) {
      throw new AppError('Limite de reports atteinte pour ce challenge', 400);
    }

    const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);
    if (week.status !== 'pending')
      throw new AppError('Seule une semaine en attente peut être reportée', 400);

    week.status = 'postponed';
    uc.flexibility.postponementsUsed += 1;

    // On rallonge la date de fin de 7 jours
    uc.endDate = new Date(uc.endDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    await uc.save();
    MonitoringService.recordChallengeEvent('postpone', 'unknown');
    return uc;
  }

  /**
   * Saute une semaine de challenge
   */
  static async skipWeek(userId: string, userChallengeId: string, weekNumber: number) {
    const uc = await UserChallenge.findOne({ _id: userChallengeId, userId });
    if (!uc) throw new AppError('Challenge non trouvé ou non autorisé', 404);

    if (uc.flexibility.skipsUsed >= uc.flexibility.skipsMax) {
      throw new AppError('Limite de "skips" atteinte pour ce challenge', 400);
    }

    const week = uc.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) throw new AppError('Semaine non trouvée', 404);
    if (week.status !== 'pending')
      throw new AppError('Seule une semaine en attente peut être sautée', 400);

    week.status = 'skipped';
    uc.flexibility.skipsUsed += 1;

    // Mise à jour de la progression (considéré comme "fait" mais sans gain)
    const processedWeeks = uc.weeks.filter((w) =>
      ['completed', 'skipped'].includes(w.status),
    ).length;
    uc.progress = Math.round((processedWeeks / uc.weeks.length) * 100);

    await uc.save();
    MonitoringService.recordChallengeEvent('skip', 'unknown');
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
    MonitoringService.recordChallengeEvent('resolve', 'unknown', result);
  }

  /**
   * Marque comme "failed" tout challenge encore `active` dont la date de fin
   * est dépassée. Sans ce job (appelé par un cron quotidien), un challenge
   * expiré restait indéfiniment `active` — l'argent déjà déposé n'était ni
   * rendu ni formellement perdu, et rien n'empêchait de continuer à valider
   * des semaines après la deadline (désormais bloqué séparément dans
   * addChallengeDeposit/validateWeek).
   */
  static async resolveExpiredChallenges(): Promise<number> {
    const expired = await UserChallenge.find({
      status: 'active',
      endDate: { $lt: new Date() },
    }).select('_id');

    for (const uc of expired) {
      try {
        await this.resolveChallenge(uc._id.toString(), 'failure');
      } catch (err: any) {
        logger.error(`Failed to resolve expired challenge ${uc._id}: ${err.message}`);
      }
    }

    if (expired.length > 0) {
      logger.info(`[Challenges] ${expired.length} challenge(s) expiré(s) marqué(s) "failed".`);
    }
    return expired.length;
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
