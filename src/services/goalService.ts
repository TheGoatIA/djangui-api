import SavingGoal from '../models/SavingGoal';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';
import mongoose from 'mongoose';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { WalletService } from './walletService';

export class GoalService {
  static async createGoal(userId: string, data: any) {
    const goal = await SavingGoal.create({ ...data, userId });

    // Metrique business
    MonitoringService.recordGoalEvent('create', data.type || 'regular');
    MonitoringService.recordGoalAmount('create', 'XAF', goal.targetAmount);

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
    const goal = await SavingGoal.findOne({ _id: id, userId });
    if (!goal) {
      throw new AppError('Goal not found', 404);
    }

    const wasAlreadyHalfway = (goal.currentAmount / goal.targetAmount) * 100 >= 50;
    const wasAlreadyCompleted = (goal.currentAmount / goal.targetAmount) * 100 >= 100;

    // 1. Débiter le wallet et créer la transaction via WalletService (Atomique)
    await WalletService.executeTransaction({
      userId,
      amount,
      type: 'saving_transfer',
      description: `Contribution objectif : ${goal.name}`,
      paymentMethod: 'wallet',
      metadata: { goalId: id, note },
    });

    // 2. Mettre à jour l'objectif
    goal.contributions.push({ amount, date: new Date(), note });
    goal.currentAmount += amount;
    await goal.save();

    // Check for milestones
    this.checkMilestones(userId, goal, wasAlreadyHalfway, wasAlreadyCompleted).catch((err) =>
      logger.error(`Milestone check error: ${err}`),
    );

    MonitoringService.recordGoalEvent('contribute', goal.type || 'unknown', 'success');
    MonitoringService.recordGoalAmount('contribute', 'XAF', amount);

    return goal;
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
    const goal = await SavingGoal.findOneAndDelete({ _id: id, userId });
    if (!goal) {
      throw new AppError('Goal not found', 404);
    }

    MonitoringService.recordGoalEvent('delete', goal.type || 'unknown');
    return true;
  }
}
