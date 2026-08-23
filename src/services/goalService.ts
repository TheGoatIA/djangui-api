import SavingGoal from '../models/SavingGoal';
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

  static async getGoals(userId: string, filters: any) {
    const query: any = { userId };
    if (filters.status) query.status = filters.status;
    if (filters.type) query.type = filters.type;

    return SavingGoal.find(query).sort({ createdAt: -1 }).lean();
  }

  static async getGoalById(id: string, userId: string) {
    const goal = await SavingGoal.findOne({ _id: id, userId }).lean();
    if (!goal) {
      throw new AppError('Goal not found', 404);
    }
    return goal;
  }

  static async addContribution(id: string, userId: string, amount: number, note?: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const goal = await SavingGoal.findOne({ _id: id, userId }).session(session);
      if (!goal) {
        throw new AppError('Goal not found', 404);
      }

      const wasAlreadyHalfway = (goal.currentAmount / goal.targetAmount) * 100 >= 50;
      const wasAlreadyCompleted = (goal.currentAmount / goal.targetAmount) * 100 >= 100;

      // 1. Débiter le wallet et créer la transaction via WalletService, dans
      // la même transaction que la mise à jour de l'objectif ci-dessous.
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount,
          type: 'saving_transfer',
          description: `Contribution objectif : ${goal.name}`,
          paymentMethod: 'wallet',
          metadata: { goalId: id, note },
        },
        { session },
      );

      // 2. Mettre à jour l'objectif
      goal.contributions.push({ amount, date: new Date(), note });
      goal.currentAmount += amount;
      await goal.save({ session });

      return { goal, transaction, wasAlreadyHalfway, wasAlreadyCompleted };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    // Check for milestones
    this.checkMilestones(
      userId,
      result.goal,
      result.wasAlreadyHalfway,
      result.wasAlreadyCompleted,
    ).catch((err) => logger.error(`Milestone check error: ${err}`));

    MonitoringService.recordGoalEvent('contribute', result.goal.type || 'unknown', 'success');
    MonitoringService.recordGoalAmount('contribute', 'XAF', amount);

    return result.goal;
  }

  /**
   * Check for milestones (50%, 100%) and send notifications
   */
  static async checkMilestones(
    userId: string,
    goal: any,
    wasAlreadyHalfway: boolean,
    wasAlreadyCompleted: boolean,
  ) {
    if (!wasAlreadyCompleted && goal.progress >= 100) {
      NotificationService.sendToUser(userId, {
        title: '',
        body: '',
        translationKey: 'GOAL_COMPLETED',
        translationData: { goalName: goal.name },
        data: { type: 'goal_completed', goalId: goal._id.toString() },
      });
    } else if (!wasAlreadyHalfway && goal.progress >= 50) {
      // Milestone: 50%
      NotificationService.sendToUser(userId, {
        title: '',
        body: '',
        translationKey: 'GOAL_MILESTONE_50',
        translationData: { goalName: goal.name },
        data: { type: 'goal_milestone', goalId: goal._id.toString(), progress: '50' },
      });
    }
  }

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
      return { goal, transaction };
    });

    result.transaction?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordGoalEvent('delete', result.goal.type || 'unknown');
    return true;
  }

  /**
   * Récupérer les fonds d'un objectif vers le portefeuille
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
      await goal.save({ session });

      return { goal, transaction };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    MonitoringService.recordGoalEvent('redeem', result.goal.type || 'unknown', 'success');

    return result.goal;
  }
}
