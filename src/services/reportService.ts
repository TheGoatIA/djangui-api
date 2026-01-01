import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import User from '../models/User';
import mongoose from 'mongoose';
import logger from '../utils/logger';

export class ReportService {
  /**
   * Get dashboard summary for the current month
   */
  static async getDashboardSummary(userId: string) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    const [user, budget, spendingStats] = await Promise.all([
      User.findById(userId).select('walletBalance monthlyIncome currency subscription'),
      Budget.findOne({ userId, 'period.month': month, 'period.year': year }),
      Transaction.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            date: { $gte: startOfMonth, $lte: endOfMonth },
            type: 'expense',
          },
        },
        {
          $group: {
            _id: null,
            totalSpent: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const totalSpent = spendingStats.length > 0 ? spendingStats[0].totalSpent : 0;
    const savingsRate =
      user?.monthlyIncome && user.monthlyIncome > 0
        ? ((user.monthlyIncome - totalSpent) / user.monthlyIncome) * 100
        : 0;

    return {
      walletBalance: user?.walletBalance || 0,
      monthlyIncome: user?.monthlyIncome || 0,
      totalSpent,
      savingsRate: Math.max(0, savingsRate),
      budgetHealth: budget
        ? {
            totalAllocated: budget.totalAllocated,
            totalSpent: budget.totalSpent,
            status: budget.status,
            percentageUsed: (budget.totalSpent / budget.totalAllocated) * 100,
          }
        : null,
      currency: user?.currency || 'XAF',
    };
  }

  /**
   * Get spending analysis by category
   */
  static async getSpendingAnalysis(userId: string, month: number, year: number) {
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    const categoryAnalysis = await Transaction.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          date: { $gte: startOfMonth, $lte: endOfMonth },
          type: 'expense',
        },
      },
      {
        $group: {
          _id: '$category',
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ]);

    return categoryAnalysis.map((cat) => ({
      category: cat._id,
      amount: cat.amount,
      count: cat.count,
    }));
  }

  /**
   * Get savings trend (last 6 months)
   */
  static async getSavingsTrend(userId: string) {
    const periods: { month: number; year: number }[] = [];
    const now = new Date();

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periods.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    }

    const trend = await Promise.all(
      periods.map(async (p) => {
        const start = new Date(p.year, p.month - 1, 1);
        const end = new Date(p.year, p.month, 0, 23, 59, 59);

        const stats = await Transaction.aggregate([
          {
            $match: {
              userId: new mongoose.Types.ObjectId(userId),
              date: { $gte: start, $lte: end },
            },
          },
          {
            $group: {
              _id: '$type',
              total: { $sum: '$amount' },
            },
          },
        ]);

        const income = stats.find((s) => s._id === 'income')?.total || 0;
        const expense = stats.find((s) => s._id === 'expense')?.total || 0;

        return {
          period: `${p.month}/${p.year}`,
          income,
          expense,
          savings: Math.max(0, income - expense),
        };
      }),
    );

    return trend;
  }
}
