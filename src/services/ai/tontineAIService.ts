import { GeminiService } from './geminiService';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../../utils/logger';
import TontineContribution from '../../models/TontineContribution';

export interface TontineOCRResult {
  amount: number;
  currency: string;
  date: Date;
  beneficiaryName: string;
  transactionRef: string;
  confidence: number;
  rawText?: string;
}

export class TontineAIService {
  /**
   * Analyse un reçu de paiement (screenshot SMS ou reçu bancaire)
   */
  static async analyzeReceipt(
    filePath: string,
    baseCurrency: string = 'XAF',
  ): Promise<TontineOCRResult> {
    try {
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString('base64');

      const prompt = `
        Analyse ce reçu de paiement mobile (Orange Money, MTN MoMo, Wave) ou virement bancaire.
        Extrais les informations suivantes en JSON:
        - transactionRef: La référence unique de la transaction (ex: ID, Ref, Numéro de transaction)
        - amount: Le montant numérique exact versé
        - currency: La devise détectée (ex: XAF, XOF, NGN)
        - date: La date et l'heure de la transaction en format ISO
        - beneficiaryName: Le nom de la personne qui a reçu l'argent (le destinataire)
        
        Si une information est illisible, utilise null.
        Retourne UNIQUEMENT le JSON.
      `;

      const parsed = await GeminiService.generateJSON(
        [
          prompt,
          {
            inlineData: {
              data: base64Data,
              mimeType: 'image/jpeg',
            },
          },
        ],
        'ocr_tontine',
      );

      return {
        transactionRef: parsed.transactionRef || 'UNKNOWN_' + Date.now(),
        amount: Number(parsed.amount) || 0,
        currency: parsed.currency || baseCurrency,
        date: parsed.date ? new Date(parsed.date) : new Date(),
        beneficiaryName: parsed.beneficiaryName || 'Inconnu',
        confidence: 0.9,
        rawText: JSON.stringify(parsed),
      };
    } catch (error: any) {
      logger.error(`Tontine AI analysis failed: ${error.message}`);
      throw new Error("L'IA n'a pas pu lire ce reçu. Assure-toi que l'image est claire.");
    }
  }

  /**
   * Calcule l'empreinte SHA-256 du fichier reçu, utilisée comme repli de détection
   * de doublon quand l'OCR n'a pas pu extraire de référence de transaction fiable
   * (auquel cas `transactionRef` retombe sur `UNKNOWN_<timestamp>`, qui n'entre
   * jamais en collision et laisserait le même reçu réutilisable indéfiniment).
   */
  static hashReceiptFile(filePath: string): string {
    const fileData = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileData).digest('hex');
  }

  /**
   * Vérifie si un reçu est un doublon, par référence de transaction détectée OU par
   * empreinte de fichier (voir hashReceiptFile).
   */
  static async isDuplicate(transactionRef: string, imageHash?: string): Promise<boolean> {
    const existing = await TontineContribution.findOne({
      $or: [
        { 'aiAnalysis.detectedRef': transactionRef },
        ...(imageHash ? [{ proofImageHash: imageHash }] : []),
      ],
      validationStatus: { $ne: 'rejected' },
    });
    return !!existing;
  }

  /**
   * Valide la pertinence temporelle du reçu
   */
  static isDateValid(receiptDate: Date, turnStartDate: Date): boolean {
    // Le reçu ne doit pas être antérieur au début du tour (avec une marge de 1h pour les fuseaux)
    const margin = 3600000; // 1 hour in ms
    return receiptDate.getTime() >= turnStartDate.getTime() - margin;
  }
}
