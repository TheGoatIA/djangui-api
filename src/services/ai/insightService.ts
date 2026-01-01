import User from '../../models/User';
import Transaction from '../../models/Transaction';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';

export class InsightService {
  static async getSpendingAnalysis(userId: string) {
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

    const prompt = PromptBuilder.buildInsightPrompt(user, transactions);
    return GeminiService.generateJSON(prompt);
  }
}
