import fs from 'fs';
import { GeminiService } from './geminiService';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/errorHandler';

export class KauriVoiceService {
  /**
   * Processes an audio file to extract transaction data using Gemini 2.0
   * @param filePath Path to the uploaded audio file
   * @param mimeType MIME type of the audio file
   * @returns Extracted transaction data in JSON format
   */
  static async processVoiceTransaction(filePath: string, mimeType: string): Promise<any> {
    try {
      const audioBuffer = fs.readFileSync(filePath);

      const currentDate = new Date().toISOString();
      const prompt = `
        Analyze this audio recording of a user describing a financial transaction.
        Context: The current date is ${currentDate}.
        
        Extract the following information in a strict JSON format:
        {
          "isValid": boolean (true if audio contains a financial transaction, false otherwise),
          "confidence": number (0 to 1 score of how sure you are about the data),
          "amount": number (the numeric value, or null if not found),
          "category": string (e.g., Food, Transport, Rent, Salary, Shopping, Entertainment, etc.),
          "description": string (a short summary of the transaction),
          "merchant": string (name of the shop, brand or service if mentioned, otherwise null),
          "type": "expense" or "income",
          "date": string (ISO format. If the user uses relative terms like "yesterday", "last week", "today", calculate it based on the current date: ${currentDate}. Otherwise null),
          "targetGoal": string (name of the goal if mentioned, otherwise null)
        }

        Rules:
        - Set "isValid" to false if the audio is irrelevant or non-financial.
        - If "isValid" is false, other fields can be null.
        - Guess the category based on the description if not explicitly stated.
        - Analyze relative dates carefully using the provided current date as a pivot.
        - The language might be French or English.
        - Return ONLY the JSON object.
      `;

      const result = await GeminiService.analyzeAudio(audioBuffer, mimeType, prompt, 'kauri-voice');

      return result;
    } catch (error: any) {
      logger.error(`Error in KauriVoiceService: ${error.message}`);
      throw new AppError('Failed to analyze voice transaction', 500);
    } finally {
      // Cleanup: remove the temporary file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
}
