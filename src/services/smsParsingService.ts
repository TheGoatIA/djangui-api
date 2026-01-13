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
      groups: { amount: 1, date: 2 },
    },
    {
      name: 'Orange Money (Paiement effectué)',
      regex: /Paiement de (\d+) FCFA effectue .* le (\d{2}\/\d{2}\/\d{4})/,
      type: 'expense',
      groups: { amount: 1, date: 2 },
    },
    {
      name: 'Orange Money (P2P Transfert)',
      // Pattern: Transfert de ... vers ... reussi. ID transaction: PP260109.1316.A84182, Montant Transaction: 36000 FCFA
      regex: /Transfert de .* vers .* reussi\. ID transaction: [A-Z]{2}(\d{6})\.(\d{4})\.[A-Z0-9]+, Montant Transaction: (\d+) FCFA/,
      type: 'expense',
      groups: { dateStr: 1, timeStr: 2, amount: 3 },
    },
    {
      name: 'MTN MoMo (Received)',
      regex: /You have received (\d+) FCFA from .* on (\d{4}-\d{2}-\d{2})/,
      type: 'income',
      groups: { amount: 1, date: 2 },
    },
    {
      name: 'MTN MoMo (Payment)',
      regex: /Transaction of (\d+) FCFA to .* was successful.* on (\d{4}-\d{2}-\d{2})/,
      type: 'expense',
      groups: { amount: 1, date: 2 },
    },
  ];

  /**
   * Parse SMS content using Regex first, then Gemini as fallback
   */
  static async parseSMS(content: string): Promise<ParsedSMS | null> {
    // 1. Try Regex Patterns
    for (const p of this.patterns as any[]) {
      const match = content.match(p.regex);
      if (match) {
        let date = new Date();
        const amount = parseInt(match[p.groups.amount || 1]);

        if (p.groups.dateStr && p.groups.timeStr) {
          // Special handling for yyMMdd.HHmm in IDs
          const d = match[p.groups.dateStr];
          const t = match[p.groups.timeStr];
          const year = 2000 + parseInt(d.substring(0, 2));
          const month = parseInt(d.substring(2, 4)) - 1;
          const day = parseInt(d.substring(4, 6));
          const hour = parseInt(t.substring(0, 2));
          const minute = parseInt(t.substring(2, 4));
          date = new Date(year, month, day, hour, minute);
        } else if (p.groups.date) {
          date = new Date(match[p.groups.date]);
        }

        return {
          amount,
          type: p.type as 'income' | 'expense',
          description: content.substring(0, 100),
          date,
          currency: 'XAF',
        };
      }
    }

    // 2. IA Fallback (Deep Extraction)
    try {
      logger.info('Regex failed for SMS, falling back to Gemini AI Expert...');
      const prompt = `
        Tu es un expert en parsing de SMS financiers (Mobile Money, Banque).
        Ton rôle est d'extraire les données d'une transaction à partir du texte brut d'un SMS.
        
        SMS À ANALYSER: "${content}"
        
        GUIDE DE DÉCODAGE :
        1. TYPE: 
           - Si le message contient "reçu", "virement de", "dépôt", "votre compte a été crédité" -> "income".
           - Si le message contient "envoyé", "transfert vers", "paiement de", "achat", "retrait", "votre compte a été débité" -> "expense".
        2. MONTANT: Extrais le montant principal de la transaction. Ignore les frais pour le champ "amount".
        3. DATE & HEURE:
           - Si un ID de transaction (ex: PP260109.1316.A84182) est présent :
             - Les 6 chiffres après les 2 premières lettres (ex: 260109) sont la date au format YYMMDD (ex: 2026-01-09).
             - Les 4 chiffres après le point (ex: 1316) sont l'heure au format HHMM (ex: 13:16).
             - Utilise cette source en priorité pour le champ "date".
           - Sinon, cherche une date au format DD/MM/YYYY ou YYYY-MM-DD.
        4. DESCRIPTION: Résume l'action (ex: "Transfert reçu de X", "Paiement facture Y").
        5. MARCHAND: Identifie le nom du service ou du magasin si présent (ex: "Canal+", "Eneo", "Orange").
        
        RÉPONDS UNIQUEMENT EN JSON (Strict):
        {
          "amount": number,
          "type": "income" | "expense",
          "description": string,
          "date": "YYYY-MM-DDTHH:mm:ssZ",
          "currency": "XAF",
          "merchant": string | null
        }
      `;
      const result = await GeminiService.generateJSON(prompt, 'sms-parsing-expert');
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
