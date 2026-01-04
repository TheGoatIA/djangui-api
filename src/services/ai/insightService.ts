import User from '../../models/User';
import Transaction from '../../models/Transaction';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { RedisService } from '../redisService';
import { AppError } from '../../middleware/errorHandler';

export class InsightService {
  static async getSpendingAnalysis(userId: string) {
    const cacheKey = RedisService.generateKey('insights', userId);
    const cached = await RedisService.get(cacheKey);
    if (cached) return cached;

    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const transactions = await Transaction.find({ userId }).sort({ date: -1 }).limit(20).lean();

    if (transactions.length === 0) {
      return {
        patterns: [],
        anomalies: [],
        healthScore: 100,
        advice:
          'Commence par enregistrer tes premières transactions pour recevoir une analyse personnalisée !',
      };
    }

    const prompt = PromptBuilder.buildInsightPrompt(user as any, transactions);
    const result = await GeminiService.generateJSON(prompt);

    if (result) {
      await RedisService.set(cacheKey, result, 3600); // 1 hour
    }

    return result;
  }
}
