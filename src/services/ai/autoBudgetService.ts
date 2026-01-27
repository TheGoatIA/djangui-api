import User from '../../models/User';
import Transaction from '../../models/Transaction';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';

export class AutoBudgetService {
    static async generateBudget(userId: string) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        if (user.subscription?.plan !== 'premium' || user.subscription?.status !== 'active') {
            throw new AppError('This is a premium feature.', 403);
        }

        // Fetch last 3 months of transactions
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const transactions = await Transaction.find({
            userId,
            date: { $gte: threeMonthsAgo }
        }).sort({ date: -1 }).lean();

        const now = new Date();
        const nextMonthDate = new Date();
        nextMonthDate.setMonth(now.getMonth() + 1);

        const context = {
            currentDate: now.toISOString(),
            targetPeriod: {
                month: nextMonthDate.getMonth() + 1,
                year: nextMonthDate.getFullYear()
            },
            transactions: transactions.map(t => ({
                amount: t.amount,
                category: t.category,
                type: t.type,
                date: t.date
            }))
        };

        const prompt = PromptBuilder.buildAutoBudgetPrompt(user as any, context);
        const result = await GeminiService.generateJSON(prompt, 'auto-budget');

        return result;
    }
}
