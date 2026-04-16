import { Request, Response } from 'express';
import { WalletService } from '../services/walletService';
import { KYCService } from '../services/kycService';
import { PayoutService } from '../services/payoutService';
import { InvoiceService } from '../services/invoiceService';
import { ChallengeService } from '../services/challengeService';
import Transaction from '../models/Transaction';
import Invoice from '../models/Invoice';
import { catchAsync } from '../utils';
import { AppError } from '../middleware/errorHandler';

export class FintechController {
  /**
   * Obtenir le solde du wallet
   */
  static readonly getBalance = catchAsync(async (req: any, res: Response) => {
    const balance = await WalletService.getBalance(req.user._id);
    res.status(200).json({
      status: 'success',
      data: balance,
    });
  });

  /**
   * Liste des transactions récentes
   */
  static readonly getTransactions = catchAsync(async (req: any, res: Response) => {
    const transactions = await Transaction.find({ userId: req.user._id })
      .sort({ date: -1 })
      .limit(20);

    res.status(200).json({
      status: 'success',
      results: transactions.length,
      data: { transactions },
    });
  });

  /**
   * Soumettre des documents KYC
   */
  static readonly submitKYC = catchAsync(async (req: any, res: Response) => {
    const { documentType, documentNumber, fullName } = req.body;
    // Les URLs d'images devraient normalement venir d'un upload S3/GCS
    const { documentImageUrl, selfieImageUrl } = req.body;

    const kyc = await KYCService.submitDocuments(req.user._id, {
      documentType,
      documentNumber,
      fullName,
      documentImageUrl,
      selfieImageUrl,
    });

    res.status(202).json({
      status: 'success',
      message: 'Documents KYC soumis et en cours de validation par IA',
      data: { kycLevel: kyc.kycLevel },
    });
  });

  /**
   * Demande de retrait (Payout)
   */
  static readonly requestWithdrawal = catchAsync(async (req: any, res: Response) => {
    // Soyez flexible pour accepter phone ou phoneNumber
    const { amount, provider } = req.body;
    const phone = req.body.phone || req.body.phoneNumber || req.body.telephone;

    if (!amount || !phone || !provider) {
      throw new AppError(
        'Montant, numéro de téléphone et fournisseur (provider) sont obligatoires.',
        400,
      );
    }

    const result = await PayoutService.initiatePayout(req.user._id, amount, {
      phone,
      provider,
    });

    res.status(200).json({
      status: 'success',
      message: 'Demande de retrait initiée',
      data: {
        transferId: result.transferId,
        reference: result.reference,
        fees: result.fees,
      },
    });
  });

  /**
   * Récupérer une facture PDF
   */
  static readonly getInvoice = catchAsync(async (req: Request, res: Response) => {
    const { transactionId } = req.params;
    let invoice = await Invoice.findOne({ transactionId });

    // Si la facture n'existe pas OU si l'URL du PDF est absente, on tente une (re)génération
    if (!invoice?.pdfUrl) {
      invoice = await InvoiceService.generateForTransaction(transactionId);
    }

    if (!invoice?.pdfUrl) {
      throw new AppError(
        "Le reçu n'a pas pu être généré ou n'est pas encore disponible sur le stockage.",
        404,
      );
    }

    res.status(200).json({
      status: 'success',
      data: {
        pdfUrl: invoice.pdfUrl,
        invoiceNumber: invoice.invoiceNumber,
      },
    });
  });

  /**
   * Récupérer une facture PDF liée à un paiement
   */
  static readonly getPaymentInvoice = catchAsync(async (req: Request, res: Response) => {
    const { paymentId } = req.params;
    let invoice = await Invoice.findOne({ paymentId });

    if (!invoice?.pdfUrl) {
      invoice = await InvoiceService.generateForPayment(paymentId);
    }

    if (!invoice?.pdfUrl) {
      throw new AppError(
        "Le reçu n'a pas pu être généré ou n'est pas encore disponible sur le stockage.",
        404,
      );
    }

    res.status(200).json({
      status: 'success',
      data: {
        pdfUrl: invoice.pdfUrl,
        invoiceNumber: invoice.invoiceNumber,
      },
    });
  });

  /**
   * Déposer de l'argent pour un challenge (Épargne réelle)
   */
  static readonly depositChallenge = catchAsync(async (req: any, res: Response) => {
    const { userChallengeId, weekNumber, amount } = req.body;
    const challenge = await ChallengeService.addChallengeDeposit(
      req.user._id,
      userChallengeId,
      weekNumber,
      amount,
    );

    res.status(200).json({
      status: 'success',
      data: { challenge },
    });
  });
}
