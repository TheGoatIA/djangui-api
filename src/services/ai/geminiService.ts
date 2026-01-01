import { model } from '../../config/gemini';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';

export class GeminiService {
    static async generateContent(prompt: string): Promise<string> {
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return response.text();
        } catch (error: any) {
            logger.error(`Gemini generateContent error: ${error.message}`);
            throw new AppError('AI Service currently unavailable', 503);
        }
    }

    static async generateJSON(prompt: string): Promise<any> {
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

            // Clean potential markdown or extra text around JSON
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                logger.error(`Gemini generateJSON failed to find JSON in response: ${text}`);
                throw new Error('Invalid AI response format');
            }

            return JSON.parse(jsonMatch[0]);
        } catch (error: any) {
            logger.error(`Gemini generateJSON error: ${error.message}`);
            throw new AppError('AI Analysis failed', 503);
        }
    }

    static async startChat(history: { role: string; parts: { text: string }[] }[]) {
        try {
            return model.startChat({
                history,
            });
        } catch (error: any) {
            logger.error(`Gemini startChat error: ${error.message}`);
            throw new AppError('AI Chat Service currently unavailable', 503);
        }
    }
}
