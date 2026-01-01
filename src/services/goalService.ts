import SavingGoal, { ISavingGoalDocument } from '../models/SavingGoal';
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

        await (goal as any).save();
        return goal;
    }

    static async updateGoal(id: string, userId: string, data: any) {
        const goal = await SavingGoal.findOneAndUpdate(
            { _id: id, userId },
            { $set: data },
            { new: true, runValidators: true }
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
