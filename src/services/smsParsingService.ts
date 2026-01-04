import { GeminiService } from './ai/geminiService';
import logger from '../utils/logger';

export interface ParsedSMS {
  amount: number;
  type: 'income' | 'expense';
  description: string;
  date: Date;
  merchant?: string;
  currency: string;
}

export class SmsParsingService {
  private static patterns = [
    {
      name: 'Orange Money (Transfert reçu)',
      regex: /Transfert de (\d+) FCFA recu de .* le (\d{2}\/\d{2}\/\d{4})/,
      type: 'income',
    },
    {
      name: 'Orange Money (Paiement effectué)',
      regex: /Paiement de (\d+) FCFA effectue .* le (\d{2}\/\d{2}\/\d{4})/,
      type: 'expense',
    },
    {
      name: 'MTN MoMo (Received)',
      regex: /You have received (\d+) FCFA from .* on (\d{4}-\d{2}-\d{2})/,
      type: 'income',
    },
    {
      name: 'MTN MoMo (Payment)',
      regex: /Transaction of (\d+) FCFA to .* was successful.* on (\d{4}-\d{2}-\d{2})/,
      type: 'expense',
    },
  ];

  /**
   * Parse SMS content using Regex first, then Gemini as fallback
   */
  static async parseSMS(content: string): Promise<ParsedSMS | null> {
    // 1. Try Regex Patterns
    for (const p of this.patterns) {
      const match = content.match(p.regex);
      if (match) {
        return {
          amount: parseInt(match[1]),
          type: p.type as 'income' | 'expense',
          description: content.substring(0, 50) + '...', // Simplified
          date: new Date(match[2]),
          currency: 'XAF',
        };
      }
    }

    // 2. IA Fallback
    try {
      logger.info('Regex failed for SMS, falling back to Gemini AI...');
      const prompt = `
        Extrais les informations de transaction de ce SMS bancaire.
        SMS: "${content}"
        
        Réponds UNIQUEMENT en JSON:
        {
          "amount": 5000,
          "type": "income" | "expense",
          "description": "Brève description",
          "date": "YYYY-MM-DD",
          "currency": "XAF",
          "merchant": "Nom si dispo"
        }
      `;
      const result = await GeminiService.generateJSON(prompt);
      if (result) {
        return {
          ...result,
          date: new Date(result.date),
        };
      }
    } catch (err: any) {
      logger.error(`Gemini SMS parsing failed: ${err.message}`);
    }

    return null;
  }
}
