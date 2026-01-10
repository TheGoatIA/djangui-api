import { genAI } from '../../config/gemini';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import SystemSetting from '../../models/SystemSetting';
import AIUsage from '../../models/AIUsage';

// Pricing Constants (Cost per 1M tokens)
// Pricing Constants (Cost per 1M tokens) - Updated Jan 2026
const PRICING: Record<string, { input: number; output: number }> = {
  // Legacy
  'gemini-1.5-flash': { input: 0.075, output: 0.3 }, // Approximate based on Flash-Lite/Previous trends
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },

  // Flash Series
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 }, // "Votre modèle le plus petit"
  'gemini-2.5-flash': { input: 0.3, output: 2.5 }, // Preview Pricing
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3-flash-preview': { input: 0.5, output: 3.0 },

  // Pro Series
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-3-pro-preview': { input: 2.0, output: 12.0 },

  // Default Fallback
  default: { input: 0.5, output: 1.0 },
};

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

  private static async saveUsage(
    modelName: string,
    context: string,
    usageMetadata: any,
    durationMs: number,
    status: 'success' | 'failure' = 'success',
    errorMessage?: string,
  ) {
    try {
      const promptTokens = usageMetadata?.promptTokenCount || 0;
      const completionTokens = usageMetadata?.candidatesTokenCount || 0;
      const totalTokens = usageMetadata?.totalTokenCount || 0;

      // Determine pricing model
      const pricing = PRICING[modelName] || PRICING['default'];
      const inputCost = (promptTokens / 1_000_000) * pricing.input;
      const outputCost = (completionTokens / 1_000_000) * pricing.output;
      const totalCost = inputCost + outputCost;

      await AIUsage.create({
        modelName,
        context,
        promptTokens,
        completionTokens,
        totalTokens,
        cost: totalCost,
        durationMs,
        status,
        errorMessage,
      });
    } catch (err) {
      logger.error(`Failed to save AI usage log: ${err}`);
    }
  }

  static async generateContent(prompt: any, context: string = 'unknown'): Promise<string> {
    const startTime = Date.now();
    let modelName = 'unknown';
    try {
      const model = await this.getModel();
      modelName = model.model;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, response.usageMetadata, duration, 'success');

      return response.text();
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, {}, duration, 'failure', error.message);

      logger.error(`Gemini generateContent error: ${error.message}`);
      throw new AppError('AI Service currently unavailable', 503);
    }
  }

  static async generateJSON(prompt: any, context: string = 'unknown'): Promise<any> {
    const startTime = Date.now();
    let modelName = 'unknown';
    try {
      const model = await this.getModel();
      modelName = model.model;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, response.usageMetadata, duration, 'success');

      const text = response.text();

      // Clean potential markdown or extra text around JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid AI response format');
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, {}, duration, 'failure', error.message);

      logger.error(`Gemini generateJSON error: ${error.message}`);
      throw new AppError('AI Analysis failed', 503);
    }
  }

  static async startChat(history: { role: string; parts: { text: string }[] }[]) {
    try {
      const model = await this.getModel();
      const chat = model.startChat({ history });

      // Proxy to intercept sendMessage
      const originalSendMessage = chat.sendMessage.bind(chat);

      chat.sendMessage = async (message: string | Array<string | any>) => {
        const startTime = Date.now();
        try {
          // Calculate input tokens implicitly?
          // Gemini API usageMetadata in response includes total prompt tokens (history + new message)

          const result = await originalSendMessage(message);
          const response = await result.response;

          const duration = Date.now() - startTime;
          // We use 'chat' as context, and model name from the factory
          GeminiService.saveUsage(model.model, 'chat', response.usageMetadata, duration, 'success');

          return result;
        } catch (err: any) {
          const duration = Date.now() - startTime;
          GeminiService.saveUsage(model.model, 'chat', {}, duration, 'failure', err.message);
          throw err;
        }
      };

      return chat;
    } catch (error: any) {
      logger.error(`Gemini startChat error: ${error.message}`);
      throw new AppError('AI Chat Service currently unavailable', 503);
    }
  }
}
