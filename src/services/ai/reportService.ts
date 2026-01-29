import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import SavingGoal from '../../models/SavingGoal';
import UserChallenge from '../../models/UserChallenge';
import TontineMember from '../../models/TontineMember';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';

export class ReportService {
  static async getMonthlyReport(userId: string, month: number, year: number) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (user.subscription?.plan !== 'premium' || user.subscription?.status !== 'active') {
      throw new AppError('This is a premium feature.', 403);
    }

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);

    const [transactions, budget, goals, challenges, tontineMembers] = await Promise.all([
      Transaction.find({ userId, date: { $gte: startDate, $lte: endDate } }).lean(),
      Budget.findOne({ userId, 'period.month': month, 'period.year': year }).lean(),
      SavingGoal.find({ userId }).lean(),
      UserChallenge.find({
        userId,
        status: 'completed',
        completedAt: { $gte: startDate, $lte: endDate },
      })
        .populate('challengeId')
        .lean(),
      TontineMember.find({ userId }).populate('tontineId').lean(),
    ]);

    const reportData = {
      month,
      year,
      income: transactions.filter((t) => t.type === 'income').reduce((sum, t) => sum + t.amount, 0),
      expenses: transactions
        .filter((t) => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0),
      topCategories: this.getTopCategories(transactions),
      budgetPerformance: budget
        ? {
            totalAllocated: budget.totalAllocated,
            spent: budget.totalSpent,
            status: budget.status,
          }
        : null,
      goalsProgress: goals.map((g) => ({ name: g.name, progress: g.progress })),
      challengesCompleted: challenges.map((c: any) => c.challengeId?.title),
      tontineSummary: tontineMembers.map((m: any) => ({
        name: m.tontineId?.name,
        trustScore: m.trustScore,
        contributions: m.totalContributed,
      })),
    };

    const prompt = PromptBuilder.buildNarrativeReportPrompt(user as any, reportData);
    const aiReport = await GeminiService.generateJSON(prompt, 'monthly-magazine-report');

    return {
      ...aiReport,
      data: reportData, // Include raw data for charts/UI
      magazineStyle: {
        coverImage: 'https://api.kauri-app.com/static/magazine/cover_premium.jpg',
        theme: 'gold_luxury',
      },
    };
  }

  private static getTopCategories(transactions: any[]) {
    const categories: Record<string, number> = {};
    transactions
      .filter((t) => t.type === 'expense')
      .forEach((t) => {
        categories[t.category] = (categories[t.category] || 0) + t.amount;
      });
    return Object.entries(categories)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, amount]) => ({ name, amount }));
  }
}
