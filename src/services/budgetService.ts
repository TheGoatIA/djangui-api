import Budget from '../models/Budget';
import { AppError } from '../middleware/errorHandler';

export class BudgetService {
  static async createBudget(userId: string, data: any) {
    const existingBudget = await Budget.findOne({
      userId,
      'period.month': data.period.month,
      'period.year': data.period.year,
    });

    if (existingBudget) {
      throw new AppError('Budget for this period already exists', 400);
    }

    const budget = await Budget.create({ ...data, userId });
    return budget;
  }

  static async getCurrentBudget(userId: string) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const budget = await Budget.findOne({
      userId,
      'period.month': month,
      'period.year': year,
    }).lean();

    return budget;
  }

  static async getBudgets(userId: string, filters: any) {
    const query: any = { userId };
    if (filters.year) query['period.year'] = parseInt(filters.year);
    if (filters.month) query['period.month'] = parseInt(filters.month);

    return Budget.find(query).sort({ 'period.year': -1, 'period.month': -1 }).lean();
  }

  static async updateBudget(id: string, userId: string, data: any) {
    const budget = await Budget.findOneAndUpdate(
      { _id: id, userId },
      { $set: data },
      { new: true, runValidators: true },
    );

    if (!budget) {
      throw new AppError('Budget not found', 404);
    }

    return budget;
  }
}
