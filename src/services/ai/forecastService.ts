import User from '../../models/User';
import Transaction from '../../models/Transaction';
import Budget from '../../models/Budget';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { RedisService } from '../redisService';
import { AppError } from '../../middleware/errorHandler';

export class ForecastService {
    /**
     * Get balance projection for the next 30 days
     */
    static async getBalanceForecast(userId: string) {
        const cacheKey = RedisService.generateKey('forecast', userId);
        const cached = await RedisService.get(cacheKey);
        if (cached) return cached;

        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        // Fetch 3 months of history + current budget to identify patterns
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        const [transactions, activeBudgets] = await Promise.all([
            Transaction.find({
                userId,
                date: { $gte: threeMonthsAgo }
            }).sort({ date: -1 }).lean(),
            Budget.find({
                userId,
                status: 'active'
            }).lean(),
        ]);

        const context = {
            recentTransactions: transactions.slice(0, 50), // Limit context size
            budgets: activeBudgets,
            currentDate: new Date().toISOString(),
        };

        const prompt = PromptBuilder.buildForecastPrompt(user as any, context);
        const result = await GeminiService.generateJSON(prompt, 'cashflow-forecast');

        if (result) {
            await RedisService.set(cacheKey, result, 3600 * 12); // 12 hours cache
        }

        return result;
    }
}
