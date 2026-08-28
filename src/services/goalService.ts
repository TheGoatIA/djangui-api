import crypto from 'crypto';
import SavingGoal from '../models/SavingGoal';
import GoalParticipant from '../models/GoalParticipant';
import User from '../models/User';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { WalletService } from './walletService';

export class GoalService {
  static async createGoal(userId: string, data: any) {
    // A goal's balance must only ever grow through addContribution (which actually
    // debits the wallet) — never accept a starting balance/progress from the caller,
    // even defensively here on top of the validator, since a fabricated currentAmount
    // can later be redeemed or refunded for real wallet credit with nothing deposited.
    // `currency` is also excluded here — always the creating user's own currency
    // (fetched below), never a client-supplied value, so currencyMiddleware can
    // tell targetAmount is already native to that currency instead of assuming XAF.
    const { currentAmount, progress, contributions, status, currency, ...safeData } = data;
    const user = await User.findById(userId).select('currency').lean();
    const goal = await SavingGoal.create({
      ...safeData,
      userId,
      currentAmount: 0,
      contributions: [],
      currency: user?.currency || 'XAF',
    });

    // Metrique business
    MonitoringService.recordGoalEvent('create', data.type || 'regular');
    MonitoringService.recordGoalAmount('create', user?.currency || 'XAF', goal.targetAmount);

    return goal;
  }

  // ─── ACCÈS PARTAGÉ ──────────────────────────────────────────────────────

  private static async getAccessibleGoalFilter(userId: string) {
    const participations = await GoalParticipant.find({
      userId,
      invitationStatus: 'accepted',
    })
      .select('goalId')
      .lean();
    const sharedGoalIds = participations.map((p) => p.goalId);
    return { $or: [{ userId }, { _id: { $in: sharedGoalIds } }] };
  }

  private static withOwnerFlag(goal: any, userId: string) {
    return { ...goal, isOwner: goal.userId?.toString() === userId.toString() };
  }

  /**
   * Destinataires des notifications d'un objectif : le propriétaire, et s'il
   * est partagé, tous les participants acceptés. Utilisé à la fois par
   * checkMilestones/notifyContribution ci-dessous et par les jobs cron
   * (progression quotidienne, échéance, suggestion de surplus) pour que
   * chacun reçoive les mêmes notifications que le propriétaire.
   */
  static async getNotifyRecipients(goal: any): Promise<string[]> {
    const ids = [goal.userId.toString()];
    if (goal.isShared) {
      const participants = await GoalParticipant.find({
        goalId: goal._id,
        invitationStatus: 'accepted',
      })
        .select('userId')
        .lean();
      ids.push(...participants.map((p) => p.userId.toString()));
    }
    return Array.from(new Set(ids));
  }

  static async getGoals(userId: string, filters: any) {
    const accessibleFilter = await GoalService.getAccessibleGoalFilter(userId);
    const query: any = { ...accessibleFilter };
    if (filters.status) query.status = filters.status;
    if (filters.type) query.type = filters.type;

    const goals = await SavingGoal.find(query).sort({ createdAt: -1 }).lean();
    return goals.map((g) => GoalService.withOwnerFlag(g, userId));
  }

  static async getGoalById(id: string, userId: string) {
    const accessibleFilter = await GoalService.getAccessibleGoalFilter(userId);
    const goal = await SavingGoal.findOne({ ...accessibleFilter, _id: id }).lean();
    if (!goal) {
      throw new AppError('Goal not found', 404);
    }
    return GoalService.withOwnerFlag(goal, userId);
  }

  static async addContribution(id: string, userId: string, amount: number, note?: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const goal = await SavingGoal.findById(id).session(session);
      if (!goal) {
        throw new AppError('Goal not found', 404);
      }

      const isOwner = goal.userId.toString() === userId.toString();
      if (!isOwner) {
        // 404, pas 403 : ne pas révéler l'existence de l'objectif à quelqu'un
        // qui n'y participe pas — même posture que getGoalById.
        const isParticipant = await GoalParticipant.exists({
          goalId: id,
          userId,
          invitationStatus: 'accepted',
        }).session(session);
        if (!isParticipant) {
          throw new AppError('Goal not found', 404);
        }
      }

      const before = GoalService.milestoneFlags(goal.currentAmount, goal.targetAmount);

      // 1. Débiter le wallet du CONTRIBUTEUR (pas forcément le propriétaire
      // si l'objectif est partagé) et créer la transaction via WalletService,
      // dans la même transaction que la mise à jour de l'objectif ci-dessous.
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount,
          type: 'saving_transfer',
          category: 'goal_contribution',
          description: `Contribution objectif : ${goal.name}`,
          paymentMethod: 'wallet',
          metadata: { goalId: id, note },
        },
        { session },
      );

      // 2. Mettre à jour l'objectif — le pot commun grandit, quel que soit
      // qui a contribué. `userId` trace l'auteur pour l'historique partagé.
      goal.contributions.push({
        userId: userId as any,
        amount,
        date: new Date(),
        note,
        type: 'contribution',
      });
      goal.currentAmount += amount;
      await goal.save({ session });

      return { goal, transaction, before };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    // Check for milestones
    this.checkMilestones(
      userId,
      result.goal,
      result.before.was25,
      result.before.was50,
      result.before.was75,
      result.before.was100,
    ).catch((err) => logger.error(`Milestone check error: ${err}`));

    if (result.goal.isShared) {
      GoalService.notifyContribution(userId, result.goal, amount).catch((err) =>
        logger.error(`Contribution notification error: ${err}`),
      );
    }

    MonitoringService.recordGoalEvent('contribute', result.goal.type || 'unknown', 'success');
    MonitoringService.recordGoalAmount('contribute', 'XAF', amount);

    return result.goal;
  }

  /**
   * Notifie les AUTRES participants d'un objectif partagé qu'une contribution
   * vient d'être versée (le contributeur lui-même est exclu — il vient de le
   * faire, inutile de le lui rappeler).
   */
  private static async notifyContribution(contributorId: string, goal: any, amount: number) {
    const recipients = (await GoalService.getNotifyRecipients(goal)).filter(
      (id) => id !== contributorId,
    );
    if (recipients.length === 0) return;

    const contributor = await User.findById(contributorId).select('firstName lastName').lean();
    const contributorName = contributor
      ? `${contributor.firstName} ${contributor.lastName}`.trim()
      : '';

    for (const uid of recipients) {
      NotificationService.sendToUser(uid, {
        title: '',
        body: '',
        translationKey: 'GOAL_CONTRIBUTION_ADDED',
        translationData: { contributorName, amount: String(amount), goalName: goal.name },
        data: { type: 'goal_contribution', goalId: goal._id.toString() },
      }).catch((err: any) => logger.error(`Notification error: ${err.message}`));
    }
  }

  /**
   * Calcule, à partir d'un montant courant, les paliers déjà atteints —
   * appelé sur `currentAmount` AVANT d'appliquer un delta (contribution
   * manuelle ou automatique) pour savoir lesquels viennent d'être franchis.
   */
  static milestoneFlags(currentAmount: number, targetAmount: number) {
    const pct = targetAmount > 0 ? (currentAmount / targetAmount) * 100 : 0;
    return {
      was25: pct >= 25,
      was50: pct >= 50,
      was75: pct >= 75,
      was100: pct >= 100,
    };
  }

  /**
   * Check for milestones (25%, 50%, 75%, 100%) and send notifications — à
   * tous les destinataires de l'objectif (propriétaire + participants
   * acceptés s'il est partagé). Atteindre un palier est un événement de
   * l'objectif dans son ensemble, contrairement à notifyContribution : le
   * contributeur reçoit aussi cette notification.
   */
  static async checkMilestones(
    userId: string,
    goal: any,
    wasAlready25: boolean,
    wasAlready50: boolean,
    wasAlready75: boolean,
    wasAlreadyCompleted: boolean,
  ) {
    const recipients = await GoalService.getNotifyRecipients(goal);
    const notify = (translationKey: string, data: Record<string, any>) => {
      for (const uid of recipients) {
        NotificationService.sendToUser(uid, {
          title: '',
          body: '',
          translationKey,
          translationData: { goalName: goal.name },
          data,
        }).catch((err: any) => logger.error(`Notification error: ${err.message}`));
      }
    };

    if (!wasAlreadyCompleted && goal.progress >= 100) {
      notify('GOAL_COMPLETED', { type: 'goal_completed', goalId: goal._id.toString() });
    } else if (!wasAlready75 && goal.progress >= 75) {
      notify('GOAL_MILESTONE_75', {
        type: 'goal_milestone',
        goalId: goal._id.toString(),
        progress: '75',
      });
    } else if (!wasAlready50 && goal.progress >= 50) {
      notify('GOAL_MILESTONE_50', {
        type: 'goal_milestone',
        goalId: goal._id.toString(),
        progress: '50',
      });
    } else if (!wasAlready25 && goal.progress >= 25) {
      notify('GOAL_MILESTONE_25', {
        type: 'goal_milestone',
        goalId: goal._id.toString(),
        progress: '25',
      });
    }
  }

  // Reste réservé au propriétaire par choix délibéré, même une fois l'accès
  // en contribution élargi aux participants : modifier la structure de
  // l'objectif (nom, montant cible, échéance, règles) reste une décision du
  // créateur seul.
  static async updateGoal(id: string, userId: string, data: any) {
    const goal = await SavingGoal.findOneAndUpdate(
      { _id: id, userId },
      { $set: data },
      { new: true, runValidators: true },
    );

    if (!goal) {
      throw new AppError('Goal not found', 404);
    }

    return goal;
  }

  // Réservé au propriétaire : la suppression rembourse le solde restant sur
  // SON wallet, quel que soit qui a contribué — élargir l'accès permettrait
  // à un participant de récupérer pour lui-même l'argent déposé par d'autres.
  static async deleteGoal(id: string, userId: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const goal = await SavingGoal.findOne({ _id: id, userId }).session(session);
      if (!goal) {
        throw new AppError('Goal not found', 404);
      }

      // Si l'objectif contient de l'argent, on rembourse avant de supprimer,
      // dans la même transaction que la suppression du document.
      let transaction: any = null;
      if (goal.currentAmount > 0) {
        let fees = 0;
        // Pénalité de 0.5% si retrait avant la deadline (si elle existe)
        if (goal.deadline && new Date() < new Date(goal.deadline) && goal.status !== 'completed') {
          fees = goal.currentAmount * 0.005;
        }

        transaction = await WalletService.executeTransaction(
          {
            userId,
            amount: goal.currentAmount,
            fees,
            type: 'deposit',
            description: `Remboursement (Suppression Objectif) : ${goal.name}`,
            paymentMethod: 'wallet',
            metadata: { goalId: id, action: 'delete_refund', penaltyApplied: fees > 0 },
          },
          { session },
        );
      }

      await SavingGoal.findByIdAndDelete(id, { session });
      // Ne pas laisser de participants orphelins pointant vers un objectif supprimé.
      await GoalParticipant.deleteMany({ goalId: id }, { session });
      return { goal, transaction };
    });

    result.transaction?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordGoalEvent('delete', result.goal.type || 'unknown');
    return true;
  }

  /**
   * Récupérer les fonds d'un objectif vers le portefeuille — réservé au
   * propriétaire, pour la même raison que deleteGoal ci-dessus.
   */
  static async redeemGoal(id: string, userId: string, amount?: number) {
    const result = await WalletService.runInTransaction(async (session) => {
      const goal = await SavingGoal.findOne({ _id: id, userId }).session(session);
      if (!goal) {
        throw new AppError('Objectif non trouvé', 404);
      }

      const redeemAmount = amount || goal.currentAmount;
      if (redeemAmount <= 0) {
        throw new AppError('Le montant à récupérer doit être supérieur à zéro', 400);
      }

      if (redeemAmount > goal.currentAmount) {
        throw new AppError("Montant supérieur au solde actuel de l'objectif", 400);
      }

      // Check for early withdrawal penalty (0.5%)
      let fees = 0;
      if (goal.deadline && new Date() < new Date(goal.deadline)) {
        fees = redeemAmount * 0.005; // 0.5% penalty
      }

      // 1. Créditer le wallet et 2. mettre à jour l'objectif dans la même
      // transaction : sans cela, un crash entre les deux permettrait de
      // relancer le rachat et d'être crédité deux fois pour le même solde.
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount: redeemAmount,
          fees, // Pénalité appliquée si retrait anticipé
          type: 'deposit',
          description: `Rachat de fonds : ${goal.name}`,
          paymentMethod: 'wallet',
          metadata: { goalId: id, action: 'redeem', earlyWithdrawal: fees > 0 },
        },
        { session },
      );

      goal.currentAmount -= redeemAmount;
      // Trace le retrait dans le même historique que les contributions
      // (`type: 'redemption'`) pour que l'utilisateur voie exactement ce
      // qui est entré et sorti du pot, pas seulement le solde courant.
      goal.contributions.push({
        userId: userId as any,
        amount: redeemAmount,
        date: new Date(),
        type: 'redemption',
      });
      await goal.save({ session });

      return { goal, transaction };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordGoalEvent('redeem', result.goal.type || 'unknown', 'success');

    return result.goal;
  }

  // ─── PARTAGE ────────────────────────────────────────────────────────────

  static async shareGoal(goalId: string, ownerId: string) {
    const goal = await SavingGoal.findOne({ _id: goalId, userId: ownerId });
    if (!goal) throw new AppError('Objectif non trouvé ou non autorisé', 404);

    if (!goal.inviteCode) {
      // CSPRNG (pas Math.random) — même exigence qu'un code d'accès, voir le
      // même choix déjà fait sur Budget.inviteCode / Tontine.inviteCode.
      goal.inviteCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    }
    goal.isShared = true;
    await goal.save();

    MonitoringService.recordGoalEvent('share', goal.type || 'unknown');

    return { inviteCode: goal.inviteCode! };
  }

  static async joinGoal(userId: string, displayName: string, inviteCode: string) {
    const goal = await SavingGoal.findOne({ inviteCode: inviteCode.toUpperCase(), isShared: true });
    if (!goal) throw new AppError("Code d'invitation invalide", 404);

    if (goal.userId.toString() === userId.toString()) {
      throw new AppError('Vous êtes déjà propriétaire de cet objectif', 400);
    }

    const existing = await GoalParticipant.findOne({ goalId: goal._id, userId });
    if (existing) {
      if (existing.invitationStatus === 'removed') {
        existing.invitationStatus = 'accepted';
        existing.joinedAt = new Date();
        await existing.save();
        MonitoringService.recordGoalEvent('join', goal.type || 'unknown');
        return goal;
      }
      throw new AppError('Vous participez déjà à cet objectif', 400);
    }

    await GoalParticipant.create({
      goalId: goal._id,
      userId,
      displayName,
      invitationStatus: 'accepted',
    });

    MonitoringService.recordGoalEvent('join', goal.type || 'unknown');

    return goal;
  }

  static async getParticipants(goalId: string, requesterId: string) {
    const goal = await SavingGoal.findById(goalId).select('userId').lean();
    if (!goal) throw new AppError('Objectif non trouvé', 404);

    const isOwner = goal.userId.toString() === requesterId.toString();
    if (!isOwner) {
      const isParticipant = await GoalParticipant.exists({
        goalId,
        userId: requesterId,
        invitationStatus: 'accepted',
      });
      if (!isParticipant) throw new AppError('Accès non autorisé', 403);
    }

    return GoalParticipant.find({ goalId, invitationStatus: 'accepted' })
      .sort({ joinedAt: 1 })
      .lean();
  }

  static async removeParticipant(goalId: string, ownerId: string, participantId: string) {
    const goal = await SavingGoal.findOne({ _id: goalId, userId: ownerId })
      .select('_id type')
      .lean();
    if (!goal) throw new AppError('Objectif non trouvé ou non autorisé', 404);

    const participant = await GoalParticipant.findOneAndUpdate(
      { _id: participantId, goalId },
      { invitationStatus: 'removed' },
      { new: true },
    );
    if (!participant) throw new AppError('Participant non trouvé', 404);

    MonitoringService.recordGoalEvent('remove_participant', goal.type || 'unknown');

    return true;
  }

  static async leaveGoal(goalId: string, userId: string) {
    const participant = await GoalParticipant.findOneAndUpdate(
      { goalId, userId, invitationStatus: 'accepted' },
      { invitationStatus: 'removed' },
      { new: true },
    );
    if (!participant) throw new AppError('Vous ne participez pas à cet objectif', 404);

    const goal = await SavingGoal.findById(goalId).select('type').lean();
    MonitoringService.recordGoalEvent('leave', goal?.type || 'unknown');

    return true;
  }
}
