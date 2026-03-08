import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import { AuditService } from './auditService';
import { NotificationService } from './notificationService';
import { MonitoringService } from './monitoringService';
import { FinancialAlertService } from './financialAlertService';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

export class WalletService {
  /**
   * Effectue un transfert de fonds sécurisé entre deux entités (ou wallet -> banque)
   * Utilise les transactions MongoDB pour garantir l'atomicité.
   */
  static async executeTransaction(data: {
    userId: string;
    amount: number;
    type:
      | 'deposit'
      | 'withdrawal'
      | 'tontine_contribution'
      | 'tontine_payout'
      | 'saving_transfer'
      | 'challenge_reward';
    description: string;
    paymentMethod: 'stripe' | 'notchpay' | 'wallet';
    reference?: string;
    externalReference?: string;
    fees?: number;
    metadata?: Record<string, any>;
    silent?: boolean;
  }) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        userId,
        amount,
        type,
        description,
        paymentMethod,
        reference,
        externalReference,
        fees = 0,
        metadata,
        silent = false,
      } = data;

      // 1. Récupérer l'utilisateur
      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      const netAmount = amount - fees;
      const transactionRef = reference || `TXN-${uuidv4().split('-')[0].toUpperCase()}`;

      // 2. Vérifier le solde si c'est un débit du wallet
      const isDebit =
        type === 'withdrawal' || type === 'tontine_contribution' || type === 'saving_transfer';
      const isCredit =
        type === 'deposit' || type === 'tontine_payout' || type === 'challenge_reward';

      // On débite seulement si c'est un type de débit explicite
      // OU si le mode est wallet ET que ce n'est PAS un type de crédit
      if (isDebit || (paymentMethod === 'wallet' && !isCredit)) {
        const totalDebit = amount;
        if (user.walletBalance < totalDebit) {
          throw new AppError('Solde insuffisant dans le portefeuille', 400);
        }
        user.walletBalance -= totalDebit;
      }

      // 3. Créditer le solde si c'est un crédit wallet
      if (isCredit) {
        user.walletBalance += netAmount;
      }

      await user.save({ session });

      // 4. Créer l'enregistrement de transaction
      const transaction = await Transaction.create(
        [
          {
            userId,
            amount: netAmount,
            currency: user.currency || 'XAF',
            type:
              type === 'deposit' || type === 'tontine_payout' || type === 'challenge_reward'
                ? 'income'
                : 'expense',
            category: type,
            description,
            status: 'completed',
            reference: transactionRef,
            externalReference,
            paymentMethod,
            fees,
            metadata,
            date: new Date(),
          },
        ],
        { session },
      );

      // 5. Audit Log & Metrics
      MonitoringService.recordTransaction(type, 'success', user.currency || 'XAF', amount);

      await AuditService.record({
        userId: userId as any,
        action: type.toUpperCase(),
        resource: 'WALLET',
        resourceId: transactionRef,
        status: 'success',
        metadata: { amount, fees, netAmount, paymentMethod },
      });

      await session.commitTransaction();
      logger.info(
        `[FINTECH] Transaction ${transactionRef} successful for user ${userId}. Amount: ${amount}, Type: ${type}`,
      );

      // 6. Monitoring d'Alerte (Async)
      FinancialAlertService.monitorTransaction({
        userId,
        amount,
        type,
        reference: transactionRef,
        status: 'success',
      }).catch((err) => logger.error(`Alert Monitoring Error: ${err.message}`));

      // 7. Notification (Hors transaction car non critique)
      if (!silent) {
        NotificationService.sendToUser(userId, {
          title: '',
          body: '',
          category: 'transactional',
          translationKey: 'TRANSACTION_SUCCESS',
          translationData: { amount, currency: user.currency, type },
          data: { transactionRef, type },
        }).catch((err) => logger.error(`Wallet Notification Error: ${err.message}`));
      }

      return transaction[0];
    } catch (error: any) {
      await session.abortTransaction();
      MonitoringService.recordTransaction(data.type, 'failure', 'XAF', data.amount);
      logger.error(
        `[FINTECH] Wallet Transaction FAILED: ${error.message} (User: ${data.userId}, Type: ${data.type})`,
      );

      // Alerte sur échec critique
      FinancialAlertService.monitorTransaction({
        userId: data.userId,
        amount: data.amount,
        type: data.type,
        reference: data.reference || 'N/A',
        status: 'failed',
      }).catch((err) => logger.error(`Failure Alert Monitoring Error: ${err.message}`));

      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Récupère le solde actuel d'un utilisateur
   */
  static async getBalance(userId: string) {
    const user = await User.findById(userId).select('walletBalance currency');
    if (!user) throw new AppError('Utilisateur non trouvé', 404);
    return {
      balance: user.walletBalance,
      currency: user.currency,
    };
  }
}
