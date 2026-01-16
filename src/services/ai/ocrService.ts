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

  /**
   * Specifically verify a challenge proof (MoMo/Orange Money screenshot)
   */
  static async verifyChallengeProof(filePath: string): Promise<OCRResult & { isReceipt: boolean; fees: number; transactionId?: string }> {
    try {
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString('base64');

      const prompt = `
        Analyze this image and determine if it is a Mobile Money (MoMo) or Orange Money transaction receipt.
        
        Extract the following information in JSON format:
        - isReceipt: boolean, true if it's a valid transaction confirmation screenshot
        - merchant: name of the service or receiver
        - amount: the MAIN transaction amount as a number (excluding fees)
        - fees: any transaction fees shown as a number (0 if not found)
        - transactionId: the unique transaction reference or ID
        - date: transaction date and time in ISO format
        - description: short summary
        
        If it's NOT a receipt (e.g. a random photo, text, etc.), set isReceipt to false.
        Extract the date and time as accurately as possible.
        Return ONLY the JSON.
      `;

      const parsed = await GeminiService.generateJSON([
        prompt,
        {
          inlineData: {
            data: base64Data,
            mimeType: 'image/jpeg',
          },
        },
      ]);

      return {
        isReceipt: !!parsed.isReceipt,
        merchant: parsed.merchant || 'Inconnu',
        amount: Number(parsed.amount) || 0,
        fees: Number(parsed.fees) || 0,
        transactionId: parsed.transactionId,
        date: parsed.date ? new Date(parsed.date) : new Date(),
        category: 'Challenge',
        description: parsed.description || 'Preuve de challenge',
        confidence: parsed.isReceipt ? 0.95 : 0.2,
      };
    } catch (error: any) {
      logger.error(`Challenge OCR verification failed: ${error.message}`);
      throw new Error("Impossible d'analyser la preuve de paiement.");
    }
  }
}
