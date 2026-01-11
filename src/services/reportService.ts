import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import User from '../models/User';
import mongoose from 'mongoose';
import logger from '../utils/logger';
import { GeminiService } from './ai/geminiService';
import { PromptBuilder } from './ai/promptBuilder';
import { RedisService } from './redisService';
import Investment from '../models/Investment';
import SavingGoal from '../models/SavingGoal';
import UserChallenge from '../models/UserChallenge';
import { AppError } from '../middleware/errorHandler';

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

  /**
   * Generate a narrative AI report for the month
   */
  static async getNarrativeReport(userId: string, month: number, year: number) {
    const cacheKey = RedisService.generateKey(
      'narrative_report',
      userId,
      month.toString(),
      year.toString(),
    );
    const cached = await RedisService.get(cacheKey);
    if (cached) return cached;

    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const [summary, categoryAnalysis, investments, goals, challenges] = await Promise.all([
      this.getDashboardSummary(userId),
      this.getSpendingAnalysis(userId, month, year),
      Investment.find({ userId, status: 'active' }),
      SavingGoal.find({ userId, status: 'active' }),
      UserChallenge.find({ userId, status: 'active' }).populate('challengeId'),
    ]);

    const investmentSummary = investments.map((inv) => ({
      title: inv.title,
      type: inv.type,
      performance: ((inv.currentValue - inv.initialAmount) / inv.initialAmount) * 100,
      currentValue: inv.currentValue,
    }));

    const reportData = {
      month,
      year,
      summary,
      categoryAnalysis,
      investmentSummary,
      goals: goals.map((g) => ({
        name: g.name,
        progress: g.progress,
        current: g.currentAmount,
        target: g.targetAmount,
      })),
      challenges: challenges.map((c: any) => ({
        title: c.challengeId.title,
        progress: c.progress,
        type: c.challengeId.type,
      })),
    };

    const prompt = PromptBuilder.buildNarrativeReportPrompt(user as any, reportData);
    const aiReport = await GeminiService.generateJSON(prompt);

    if (aiReport) {
      await RedisService.set(cacheKey, aiReport, 3600 * 6); // 6 hours
    }

    return aiReport;
  }

  /**
   * Get global application stats for the last 24 hours (Admin Report)
   */
  static async getGlobalDailyStats() {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [newUsers, transactions, activeSessions] = await Promise.all([
      // 1. New Users
      User.countDocuments({ createdAt: { $gte: yesterday } }),

      // 2. Transactions (Count & Volume)
      Transaction.aggregate([
        { $match: { date: { $gte: yesterday } } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
          },
        },
      ]),

      // 3. Active Users (Users who had session activity in last 24h)
      User.countDocuments({ 'sessions.lastActive': { $gte: yesterday } }),
    ]);

    const incomeStats = transactions.find((t) => t._id === 'income') || {
      count: 0,
      totalAmount: 0,
    };
    const expenseStats = transactions.find((t) => t._id === 'expense') || {
      count: 0,
      totalAmount: 0,
    };

    return {
      period: {
        start: yesterday,
        end: now,
      },
      users: {
        new: newUsers,
        active: activeSessions,
      },
      transactions: {
        income: {
          count: incomeStats.count,
          volume: incomeStats.totalAmount,
        },
        expense: {
          count: expenseStats.count,
          volume: expenseStats.totalAmount,
        },
      },
    };
  }

  /**
   * Check for users with financial balance discrepancies (Audit/Health check)
   */
  static async checkFinancialIntegrity() {
    const activeUsers = await User.find({ isActive: true });
    const anomalies: any[] = [];

    for (const user of activeUsers) {
      const stats = await Transaction.aggregate([
        { $match: { userId: user._id } },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
          },
        },
      ]);

      const income = stats.find((s) => s._id === 'income')?.total || 0;
      const expense = stats.find((s) => s._id === 'expense')?.total || 0;
      const calculatedBalance = income - expense;

      // Check if calculated balance matches walletBalance (allowing minor floating point difference)
      const diff = Math.abs(calculatedBalance - user.walletBalance);
      if (diff > 0.01) {
        anomalies.push({
          userId: user._id,
          email: user.email,
          walletBalance: user.walletBalance,
          calculatedBalance,
          diff,
        });
      }
    }

    if (anomalies.length > 0) {
      logger.warn(`Financial Integrity Check: Found ${anomalies.length} anomalies.`);
      // We'll alert this in CronService
    } else {
      logger.info('Financial Integrity Check: No anomalies found.');
    }

    return anomalies;
  }
}
