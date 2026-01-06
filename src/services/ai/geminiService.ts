import { genAI } from '../../config/gemini';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import SystemSetting from '../../models/SystemSetting';

export class GeminiService {
  private static async getModel() {
    try {
      // Fetch model ID from system settings, default to gemini-2.5-flash
      const setting = await SystemSetting.findOne({ key: 'gemini_model' });
      const modelId = setting?.value || 'gemini-2.5-flash';

      return genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      });
    } catch (error) {
      logger.warn(`Failed to fetch Gemini model setting, using default: ${error}`);
      return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    }
  }

  static async generateContent(prompt: any): Promise<string> {
    try {
      const model = await this.getModel();
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error: any) {
      logger.error(`Gemini generateContent error: ${error.message}`);
      throw new AppError('AI Service currently unavailable', 503);
    }
  }

  static async generateJSON(prompt: any): Promise<any> {
    try {
      const model = await this.getModel();
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
      const model = await this.getModel();
      return model.startChat({
        history,
      });
    } catch (error: any) {
      logger.error(`Gemini startChat error: ${error.message}`);
      throw new AppError('AI Chat Service currently unavailable', 503);
    }
  }
}
