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
import TontineMember from '../models/TontineMember';
import TontineContribution from '../models/TontineContribution';
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

    const [summary, categoryAnalysis, investments, goals, challenges, tontineData] =
      await Promise.all([
        this.getDashboardSummary(userId),
        this.getSpendingAnalysis(userId, month, year),
        Investment.find({ userId, status: 'active' }),
        SavingGoal.find({ userId, status: 'active' }),
        UserChallenge.find({ userId, status: 'active' }).populate('challengeId'),
        this.getTontineMonthSummary(userId, month, year),
      ]);

    const investmentSummary = investments.map((inv: any) => ({
      type: inv.type,
      amount: inv.amount,
      expectedReturn: inv.expectedReturn,
      progress: inv.progress,
    }));

    const goalSummary = goals.map((g: any) => ({
      name: g.name,
      targetAmount: g.targetAmount,
      currentAmount: g.currentAmount,
      deadline: g.deadline,
    }));

    const reportData = {
      month,
      year,
      summary,
      categoryAnalysis,
      investmentSummary,
      goals: goalSummary,
      challenges: challenges.map((c: any) => ({
        title: c.challengeId.title,
        progress: c.progress,
        type: c.challengeId.type,
      })),
      tontines: tontineData,
    };

    const prompt = PromptBuilder.buildNarrativeReportPrompt(user as any, reportData);
    const aiReport = await GeminiService.generateJSON(prompt);

    if (aiReport) {
      await RedisService.set(cacheKey, aiReport, 3600 * 6); // 6 hours
    }

    return aiReport;
  }

  /**
   * Get global application stats for the last 24 hours (Admin Report) - UPGRADED
   */
  static async getGlobalDailyStats() {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [newUsers, transactions, activeSessions, aumData] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: yesterday } }),
      Transaction.aggregate([
        { $match: { date: { $gte: yesterday }, status: 'completed' } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            totalVolume: { $sum: '$amount' },
            totalFees: { $sum: '$fees' },
          },
        },
      ]),
      User.countDocuments({ 'sessions.lastActive': { $gte: yesterday } }),
      this.calculateRealMoneyAUM(),
    ]);

    const totalVolume = transactions.reduce((acc, t) => acc + t.totalVolume, 0);
    const totalFees = transactions.reduce((acc, t) => acc + t.totalFees, 0);
    const anomalies = await this.checkFinancialIntegrity();
    const anomalyCount = anomalies.length;

    // Calcul du niveau de risque
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (anomalyCount > 10 || totalVolume > aumData.totalAUM * 0.5) {
      riskLevel = 'high';
    } else if (anomalyCount > 0 || totalVolume > aumData.totalAUM * 0.2) {
      riskLevel = 'medium';
    }

    return {
      period: { start: yesterday, end: now },
      users: { new: newUsers, active: activeSessions },
      transactions: {
        totalVolume,
        count: transactions.reduce((acc, t) => acc + t.count, 0),
      },
      revenue: {
        totalFees,
        margin: totalVolume > 0 ? (totalFees / totalVolume) * 100 : 0,
      },
      health: {
        totalAUM: aumData.totalAUM,
        anomalyCount,
        riskLevel,
      },
      growth: { newUsers },
    };
  }

  /**
   * Calcule le montant total d'argent réel "sous gestion" (Total des balances wallet)
   */
  static async calculateRealMoneyAUM() {
    const stats = await User.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: null, totalAUM: { $sum: '$walletBalance' } } },
    ]);
    return { totalAUM: stats[0]?.totalAUM || 0 };
  }

  /**
   * Check for users with financial balance discrepancies (Audit/Health check)
   */
  static async checkFinancialIntegrity() {
    const activeUsers = await User.find({ isActive: true });
    const anomalies: any[] = [];

    for (const user of activeUsers) {
      const stats = await Transaction.aggregate([
        { $match: { userId: user._id, status: 'completed' } },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            totalFees: { $sum: '$fees' },
          },
        },
      ]);

      // Calcul simple : Revenus (deposit, payout, reward) - Dépenses (withdrawal, contribution, transfer)
      let income = 0;
      let expense = 0;

      stats.forEach((s) => {
        if (['income', 'deposit', 'tontine_payout', 'challenge_reward'].includes(s._id)) {
          income += s.total;
        } else {
          expense += s.total + s.totalFees; // On déduit le net + les frais
        }
      });

      const calculatedBalance = income - expense;
      const diff = Math.abs(calculatedBalance - user.walletBalance);

      if (diff > 1) {
        // Tolérance de 1 XAF pour les arrondis
        anomalies.push({
          userId: user._id,
          email: user.email,
          walletBalance: user.walletBalance,
          calculatedBalance,
          diff,
        });
      }
    }

    return anomalies;
  }

  /**
   * Get tontine summary for a given month
   */
  static async getTontineMonthSummary(userId: string, month: number, year: number) {
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    const members = await TontineMember.find({ userId, invitationStatus: 'accepted' }).populate(
      'tontineId',
    );

    let totalContributed = 0;
    const details = [];

    for (const member of members) {
      const contributions = await TontineContribution.find({
        memberId: member._id,
        paidAt: { $gte: startOfMonth, $lte: endOfMonth },
        validationStatus: 'completed',
      });

      const contributed = contributions.reduce((acc, curr) => acc + curr.amountPaid, 0);
      totalContributed += contributed;

      details.push({
        tontineName: (member.tontineId as any).name,
        contributed,
        trustScore: member.trustScore,
      });
    }

    return { totalContributed, details };
  }

  /**
   * Génère un rapport financier complet pour l'admin
   */
  static async getExecutiveFinancialReport(period: 'daily' | 'weekly' | 'monthly' = 'daily') {
    const stats = await this.getGlobalDailyStats();
    return stats;
  }
}
