import SavingGoal from '../models/SavingGoal';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';

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
    const goal = await SavingGoal.findOne({ _id: id, userId });
    if (!goal) {
      throw new AppError('Goal not found', 404);
    }

    goal.contributions.push({ amount, date: new Date(), note });
    goal.currentAmount += amount;

    const wasAlreadyCompleted = goal.progress >= 100;
    await (goal as any).save();

    if (!wasAlreadyCompleted && goal.progress >= 100) {
      NotificationService.sendToUser(userId, {
        title: 'Félicitations ! 🎯',
        body: `Tu as atteint ton objectif d'épargne : ${goal.name} !`,
        data: { type: 'goal_completed', goalId: goal._id.toString() },
      });
    }

    return goal;
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
