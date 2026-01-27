import User from '../../models/User';
import { ForecastService } from './forecastService';
import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import { AppError } from '../../middleware/errorHandler';

export class OracleService {
    /**
     * Generates predictive alerts for a premium user
     */
    static async getAlerts(userId: string) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        if (user.subscription?.plan !== 'premium' || user.subscription?.status !== 'active') {
            throw new AppError('This is a premium feature.', 403);
        }

        // Reuse ForecastService to get projected data
        const forecast = await ForecastService.getBalanceForecast(userId);

        // Add tontine context (future contributions) to forecast data for the prompt
        // For now, buildOraclePrompt will use the forecast result directly
        const prompt = PromptBuilder.buildOraclePrompt(user as any, forecast);
        const result = await GeminiService.generateJSON(prompt, 'oracle-alerts');

        return result;
    }
}
