import UserChallenge from '../models/UserChallenge';
import { currentLanguage } from '../utils/requestContext';
import Challenge from '../models/Challenge';
import { WalletService } from './walletService';
import { GamificationService } from './gamificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';

// Même arrondi que WalletService/TransactionService/GoalService — appliqué à
// chaque écriture d'un montant persisté, pas seulement au résultat final
// (audit F-06 : une addition de deux flottants "propres" peut déjà produire
// une valeur du type 999.9999999999999 en IEEE 754).
const roundAmount = (n: number): number => Math.round(n * 100) / 100;

/**
 * Single progress rule for every path (validate / skip): a week is "processed"
 * once completed or skipped. validateWeek used to count only completed weeks
 * while skipWeek counted both — after one skip, validating every other week
 * capped progress at 75 %: the challenge never completed and the saved money
 * could only be recovered by quitting with a penalty.
 */
function applyProgress(uc: any): boolean {
  const processed = uc.weeks.filter((w: any) => ['completed', 'skipped'].includes(w.status)).length;
  uc.progress = uc.weeks.length ? Math.round((processed / uc.weeks.length) * 100) : 0;
  const done = uc.progress >= 100 && uc.status === 'active';
  if (done) {
    uc.status = 'completed';
    uc.completedAt = new Date();
  }
  return done;
}

const isHttpUrl = (u: unknown) => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u);

export class ChallengeService {
  /**
   * Liste tous les challenges disponibles
   */
  static async getAllChallenges() {
    const list = await Challenge.find().sort({ createdAt: -1 });
    return list.map((c) => ChallengeService.localize(c.toObject()));
  }

  /** Titre/description dans la langue de l'utilisateur (anglais si disponible). */
  static localize(c: any) {
    if (!c || typeof c !== 'object') return c;
    if (currentLanguage() === 'en') {
      if (c.titleEn) c.title = c.titleEn;
      if (c.descriptionEn) c.description = c.descriptionEn;
    }
    return c;
  }

  /**
   * Liste les challenges d'un utilisateur
   */
  static async getUserChallenges(userId: string) {
    const list = await UserChallenge.find({ userId })
      .populate('challengeId')
      .sort({ createdAt: -1 });
    // Proof images stored in our (private) storage are served as signed URLs.
    const { StorageService } = await import('./storageService');
    return Promise.all(
      list.map(async (uc) => {
        const o: any = uc.toObject();
        if (o.challengeId) o.challengeId = ChallengeService.localize(o.challengeId);
        for (const w of o.weeks || []) {
          if (w.proofImageUrl)
            w.proofImageUrl = await StorageService.signStoredUrl(w.proofImageUrl);
        }
        return o;
      }),
    );
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

    let created;
    try {
      created = await UserChallenge.create({
        userId,
        challengeId,
        endDate,
        weeks,
        status: 'active',
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new AppError('Vous participez déjà à ce challenge', 400);
      throw err;
    }

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

    transaction
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

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
        throw new AppError("Ce challenge n'est plus actif", 400);
      if (userChallenge.endDate < new Date()) throw new AppError('Ce challenge est expiré', 400);

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
      week.savedAmount = roundAmount(week.savedAmount + amount);
      if (week.savedAmount >= week.targetAmount) {
        week.status = 'completed';
        week.validatedAt = new Date();
      }
      week.transactionId = transaction.reference;

      userChallenge.currentValue = roundAmount(userChallenge.currentValue + amount);
      await userChallenge.save({ session });

      return { userChallenge, transaction };
    });

    (result.transaction as any)
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

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
      if (uc.status !== 'active') throw new AppError("Ce challenge n'est plus actif", 400);
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

          week.savedAmount = roundAmount(week.savedAmount + amountToWithdraw);
          week.transactionId = transaction.reference;
          uc.currentValue = roundAmount(uc.currentValue + amountToWithdraw);
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
      if (data?.proofImageUrl !== undefined) {
        // Rendered as a link (app, admin): only http(s) — never javascript:/data:.
        if (!isHttpUrl(data.proofImageUrl)) throw new AppError('Lien de preuve invalide', 400);
        week.proofImageUrl = data.proofImageUrl;
      }
      if (data?.note) week.verificationNote = String(data.note).slice(0, 500);

      const shouldAwardCompletion = applyProgress(uc);

      await uc.save({ session });

      return { uc, transaction, shouldAwardCompletion };
    });

    result.transaction
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

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

      if (uc.status !== 'completed') {
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

    (result.transaction as any)
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

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

    // Considéré comme "fait" mais sans gain — même règle que validateWeek.
    const completed = applyProgress(uc);

    await uc.save();
    if (completed) {
      GamificationService.awardChallengeCompletion(userId, 'Challenge Réussi').catch((err: any) =>
        logger.error(`Gamification award error: ${err.message}`),
      );
    }
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
          titleEn: 'Emergency Savings',
          descriptionEn: 'Save 50,000 XAF in 4 weeks to be ready for the unexpected.',
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
          titleEn: 'Pro Tontine Member',
          descriptionEn: "Don't miss a single contribution for 3 months.",
          type: 'habit',
          durationDays: 90,
          difficulty: 'medium',
          rewardPoints: 1000,
          icon: '💎',
        },
        {
          title: 'Zéro Dépense Inutile',
          description: 'Réduisez vos dépenses de divertissement de 20% ce mois-ci.',
          titleEn: 'Zero Wasteful Spending',
          descriptionEn: 'Cut your entertainment spending by 20% this month.',
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
    userChallenge.currentValue = roundAmount(userChallenge.currentValue + amount);

    if (userChallenge.progress >= 100 && userChallenge.status === 'active') {
      await this.resolveChallenge(userChallengeId, 'success');
    } else {
      await userChallenge.save();
    }
  }
}
