import fs from 'fs';
import { GeminiService } from './geminiService';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';
import UserActivity from '../../models/UserActivity';

export class AnneVoiceService {
  /**
   * Processes an audio file to extract transaction data using Gemini 2.0
   * @param filePath Path to the uploaded audio file
   * @param mimeType MIME type of the audio file
   * @param userId ID of the user (for tracking)
   * @returns Extracted transaction data in JSON format
   */
  static async processVoiceTransaction(filePath: string, mimeType: string, userId?: string): Promise<any> {
    try {
      const audioBuffer = fs.readFileSync(filePath);

      const currentDate = new Date().toISOString();
      const prompt = `
        Tu es Anne, experte en finances. Analyse cet enregistrement audio d'un utilisateur décrivant une transaction financière.
        Contexte: La date actuelle est ${currentDate}.
        
        Extrais les informations suivantes au format JSON strict:
        {
          "isValid": boolean (true si l'audio contient une transaction financière, false sinon),
          "confidence": number (score de 0 à 1 de ta certitude),
          "amount": number (la valeur numérique, ou null),
          "category": string (ex: Alimentation, Transport, Loyer, Salaire, Shopping, Loisirs, etc.),
          "description": string (un court résumé de la transaction),
          "merchant": string (nom du magasin ou service si mentionné, sinon null),
          "type": "expense" or "income",
          "date": string (format ISO. Si l'utilisateur utilise des termes relatifs comme "hier", "la semaine dernière", "aujourd'hui", calcule-le à partir de: ${currentDate}. Sinon null),
          "targetGoal": string (nom de l'objectif si mentionné, sinon null)
        }

        Règles:
        - Réponds uniquement en JSON.
        - Si valid est false, les autres champs peuvent être null.
        - La langue peut être le Français ou l'Anglais.
      `;

      const result = await GeminiService.analyzeAudio(audioBuffer, mimeType, prompt, 'anne-voice');

      if (userId) {
        // Track Activity
        UserActivity.create({
          userId,
          feature: 'AI_Voice',
          action: 'process_voice_transaction',
          details: { isValid: result.isValid, confidence: result.confidence }
        }).catch(e => logger.warn(`Failed to log voice activity: ${e}`));
      }

      return result;
    } catch (error: any) {
      logger.error(`Error in AnneVoiceService: ${error.message}`);
      throw new AppError('Failed to analyze voice transaction', 500);
    } finally {
      // Cleanup: remove the temporary file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
}
