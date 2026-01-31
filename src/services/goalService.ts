import SavingGoal from '../models/SavingGoal';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';
import mongoose from 'mongoose';
import logger from '../utils/logger';

export class GoalService {
  static async createGoal(userId: string, data: any) {
    const goal = await SavingGoal.create({ ...data, userId });
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
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const goal = await SavingGoal.findOne({ _id: id, userId }).session(session);
      if (!goal) {
        throw new AppError('Goal not found', 404);
      }

      // Add contribution to goal
      goal.contributions.push({ amount, date: new Date(), note });
      goal.currentAmount += amount;

      const wasAlreadyHalfway = ((goal.currentAmount - amount) / goal.targetAmount) * 100 >= 50;
      const wasAlreadyCompleted = ((goal.currentAmount - amount) / goal.targetAmount) * 100 >= 100;

      await (goal as any).save({ session });

      // Create a corresponding transaction
      const Transaction = mongoose.model('Transaction');
      const User = mongoose.model('User');

      const description =
        goal.type === 'debt'
          ? `Remboursement dette : ${goal.name}`
          : `Contribution objectif : ${goal.name}`;

      await Transaction.create(
        [
          {
            userId,
            amount,
            type: 'expense',
            category: goal.type === 'debt' ? 'Dettes' : 'Épargne',
            description,
            date: new Date(),
            linkedGoalId: goal._id,
            isAutoCategorized: true,
          },
        ],
        { session },
      );

      // Update User Wallet Balance
      await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } }, { session });

      await session.commitTransaction();

      // Check for milestones after commit (to send notifications)
      this.checkMilestones(userId, goal, wasAlreadyHalfway, wasAlreadyCompleted).catch((err) =>
        logger.error(`Milestone check error: ${err}`),
      );

      return goal;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
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
    return true;
  }
}
