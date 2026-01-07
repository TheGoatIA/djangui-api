import { GeminiService } from './geminiService';
import fs from 'fs';
import logger from '../../utils/logger';

export interface OCRResult {
  merchant?: string;
  amount: number;
  date: Date;
  category: string;
  description: string;
  confidence: number;
}

export class OCRService {
  /**
   * Scan a receipt image using Gemini AI
   */
  static async scanReceipt(filePath: string): Promise<OCRResult> {
    try {
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString('base64');

      const prompt = `
        Analyze this receipt image and extract the following information in JSON format:
        - merchant: name of the store or service provider
        - amount: total transaction amount as a number
        - date: transaction date in ISO format
        - category: one of [Alimentation, Transport, Logement, Loisirs, Santé, Shopping, Autres]
        - description: short summary of items or purpose
        
        If information is missing, use null for strings and 0 for amount.
        Return ONLY the JSON.
      `;

      const parsed = await GeminiService.generateJSON([
        prompt,
        {
          inlineData: {
            data: base64Data,
            mimeType: 'image/jpeg', // Multer filter ensures it's an image or pdf
          },
        },
      ]);

      return {
        merchant: parsed.merchant || 'Inconnu',
        amount: Number(parsed.amount) || 0,
        date: parsed.date ? new Date(parsed.date) : new Date(),
        category: parsed.category || 'Autres',
        description: parsed.description || `Achat chez ${parsed.merchant || 'Inconnu'}`,
        confidence: 0.9, // Placeholder for Gemini's internal scoring if accessible
      };
    } catch (error: any) {
      logger.error(`OCR scan failed: ${error.message}`);
      throw new Error("Erreur lors de l'analyse du reçu par l'IA.");
    }
  }
}
