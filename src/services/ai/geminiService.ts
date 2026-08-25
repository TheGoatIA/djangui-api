import { genAI } from '../../config/gemini';
import { HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import SystemSetting from '../../models/SystemSetting';
import AIUsage from '../../models/AIUsage';
import { MonitoringService } from '../monitoringService';

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
  private static async getModel(systemInstruction?: string) {
    try {
      // Fetch model ID from system settings, default to gemini-2.5-flash
      const setting = await SystemSetting.findOne({ key: 'gemini_model' });
      const modelId = setting?.value || 'gemini-2.5-flash';

      return genAI.getGenerativeModel({
        model: modelId,
        systemInstruction,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
        ],
      });
    } catch (error) {
      logger.warn(`Failed to fetch Gemini model setting, using default: ${error}`);
      return genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction,
      });
    }
  }

  /**
   * Détecte les tentatives d'injection de prompt ou de jailbreak
   */
  static detectAttack(input: string): boolean {
    const attackPatterns = [
      /ignore previous instructions/i,
      /ignore all instructions/i,
      /disregard previous/i,
      /system prompt/i,
      /base prompt/i,
      /reveal your instructions/i,
      /what are your instructions/i,
      /repète tout ce qui précède/i,
      /donne moi ton prompt/i,
      /tu es maintenant/i,
      /act as a/i,
      /jailbreak/i,
      / DAN /i,
      /dev mode/i,
    ];

    return attackPatterns.some((pattern) => pattern.test(input));
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

      // Prometheus Metrics
      MonitoringService.recordAiRequest(context, modelName, status);
      MonitoringService.observeAiDuration(context, modelName, durationMs / 1000);
      MonitoringService.recordAiTokens(modelName, 'input', promptTokens);
      MonitoringService.recordAiTokens(modelName, 'output', completionTokens);

      // recordAiContextEfficiency(total, prompt)
      if (promptTokens > 0) {
        MonitoringService.recordAiContextEfficiency(totalTokens, promptTokens);
      }
    } catch (err) {
      logger.error(`Failed to save AI usage log: ${err}`);
    }
  }

  static async generateContent(
    prompt: any,
    context: string = 'unknown',
    systemInstruction?: string,
  ): Promise<string> {
    const startTime = Date.now();
    let modelName = 'unknown';
    try {
      const model = await this.getModel(systemInstruction);
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
      const detail = process.env.NODE_ENV !== 'production' ? ` (${error.message})` : '';
      throw new AppError(`AI Service currently unavailable${detail}`, 503);
    }
  }

  static async generateJSON(
    prompt: any,
    context: string = 'unknown',
    systemInstruction?: string,
  ): Promise<any> {
    const startTime = Date.now();
    let modelName = 'unknown';
    try {
      const model = await this.getModel(systemInstruction);
      modelName = model.model;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, response.usageMetadata, duration, 'success');

      const text = response.text();

      if (!text || text.trim().length === 0) {
        const blockReason = response.promptFeedback?.blockReason;
        const candidate = response.candidates?.[0];
        logger.warn(
          `AI returned empty text. Block Reason: ${blockReason}, Finish Reason: ${candidate?.finishReason}`,
        );

        if (blockReason) {
          throw new Error(`AI response blocked due to safety filters: ${blockReason}`);
        }
      }

      return this.parseJSON(text);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, {}, duration, 'failure', error.message);

      logger.error(`Gemini generateJSON error [Model: ${modelName}]: ${error.message}`);
      // Surfaced outside production: this catch swallows everything (quota,
      // safety block, malformed JSON from the model, network...) behind one
      // generic message, which made a real first-run failure (e.g. the
      // forecast prompt) indistinguishable from any other cause without
      // digging through server logs.
      const detail = process.env.NODE_ENV !== 'production' ? ` (${error.message})` : '';
      throw new AppError(`AI Analysis failed${detail}`, 503);
    }
  }

  static parseJSON(text: string): any {
    try {
      // 1. Try to find JSON in markdown code blocks
      const markdownMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (markdownMatch) {
        return JSON.parse(markdownMatch[1]);
      }

      // 2. Try to find anything between the first { and the last }
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`AI Response has no JSON: "${text.substring(0, 500)}..."`);
        throw new Error('Invalid AI response format: No JSON object found');
      }

      // Cleanup: remove any trailing characters after the last } if necessary
      let jsonStr = jsonMatch[0];
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        // If it fails, maybe there's text after the JSON bracket
        // Let's try to find the last closing brace that balances the first opening one
        let balance = 0;
        let lastIndex = -1;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') balance++;
          if (jsonStr[i] === '}') {
            balance--;
            if (balance === 0) {
              lastIndex = i;
              break;
            }
          }
        }
        if (lastIndex !== -1) {
          return JSON.parse(jsonStr.substring(0, lastIndex + 1));
        }
        throw e;
      }
    } catch (error: any) {
      logger.error(`Failed to parse JSON from AI response: ${error.message}`);
      // Show snippet around the error if possible
      if (error.message.includes('position')) {
        const pos = parseInt(error.message.match(/position (\d+)/)?.[1] || '0');
        const snippet = text.substring(Math.max(0, pos - 50), Math.min(text.length, pos + 50));
        logger.debug(`Error snippet: "...${snippet}..."`);
      }
      logger.debug(`Raw response length: ${text.length} chars`);
      throw new Error('Invalid AI response format');
    }
  }

  static async analyzeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    prompt: string,
    context: string = 'voice-analysis',
    systemInstruction?: string,
  ): Promise<any> {
    const startTime = Date.now();
    let modelName = 'unknown';
    try {
      const model = await this.getModel(systemInstruction);
      modelName = model.model;

      const result = await model.generateContent([
        {
          inlineData: {
            data: audioBuffer.toString('base64'),
            mimeType,
          },
        },
        { text: prompt },
      ]);

      const response = await result.response;
      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, response.usageMetadata, duration, 'success');

      const text = response.text();
      return this.parseJSON(text);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.saveUsage(modelName, context, {}, duration, 'failure', error.message);
      logger.error(`Gemini analyzeAudio error: ${error.message}`);
      throw new AppError('Voice analysis failed', 503);
    }
  }

  static async startChat(
    history: { role: string; parts: { text: string }[] }[],
    systemInstruction?: string,
  ) {
    try {
      const model = await this.getModel(systemInstruction);
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
