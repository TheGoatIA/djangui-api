import { GeminiService } from './geminiService';
import { PromptBuilder } from './promptBuilder';
import logger from '../../utils/logger';

export class CategorizationService {
    static async categorize(description: string, amount: number, merchant?: string) {
        const prompt = PromptBuilder.buildCategorizationPrompt(description, amount, merchant);
        try {
            const result = await GeminiService.generateJSON(prompt);
            return result;
        } catch (error) {
            logger.error('Categorization service failed, falling back to "Autres"');
            return {
                category: 'Autres',
                subcategory: 'Inconnu',
                confidence: 0,
                reasoning: 'AI Error fallback',
            };
        }
    }
}
