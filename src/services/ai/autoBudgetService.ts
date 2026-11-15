import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';
import { isSubscriptionEntitled } from '../../utils/subscription';

export class AutoBudgetService {
  static async generateBudget(userId: string, requestedMonth?: number, requestedYear?: number) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (!isSubscriptionEntitled(user.subscription)) {
      throw new AppError('This is a premium feature.', 403);
    }

    // Fetch last 3 months of transactions
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const transactions = await Transaction.find({
      userId,
      date: { $gte: threeMonthsAgo },
    })
      .sort({ date: -1 })
      .lean();

    const now = new Date();
    let targetMonth = requestedMonth;
    let targetYear = requestedYear;

    // Intelligent Fallback Logic if no period is requested
    if (!targetMonth || !targetYear) {
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      // Check if a budget already exists for the current month
      const existingBudget = await Budget.findOne({
        userId,
        'period.month': currentMonth,
        'period.year': currentYear,
      });

      if (!existingBudget) {
        // If no budget for current month, prioritize current month
        targetMonth = currentMonth;
        targetYear = currentYear;
      } else {
        // If budget exists, default to next month
        const nextMonthDate = new Date();
        nextMonthDate.setMonth(now.getMonth() + 1);
        targetMonth = nextMonthDate.getMonth() + 1;
        targetYear = nextMonthDate.getFullYear();
      }
    }

    const context = {
      currentDate: now.toISOString(),
      targetPeriod: {
        month: targetMonth,
        year: targetYear,
      },
      transactions: transactions.map((t) => ({
        amount: t.amount,
        category: t.category,
        type: t.type,
        date: t.date,
      })),
    };

    const prompt = PromptBuilder.buildAutoBudgetPrompt(user as any, context);
    const result = await GeminiService.generateJSON(prompt, 'auto-budget');

    return result;
  }
}
