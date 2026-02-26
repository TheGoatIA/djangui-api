import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import { AuditService } from './auditService';
import { NotificationService } from './notificationService';
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
        type: 'deposit' | 'withdrawal' | 'tontine_contribution' | 'tontine_payout' | 'saving_transfer' | 'challenge_reward';
        description: string;
        paymentMethod: 'stripe' | 'notchpay' | 'wallet';
        reference?: string;
        externalReference?: string;
        fees?: number;
        metadata?: Record<string, any>;
    }) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { userId, amount, type, description, paymentMethod, reference, externalReference, fees = 0, metadata } = data;

            // 1. Récupérer l'utilisateur
            const user = await User.findById(userId).session(session);
            if (!user) throw new AppError('Utilisateur non trouvé', 404);

            const netAmount = amount - fees;
            const transactionRef = reference || `TXN-${uuidv4().split('-')[0].toUpperCase()}`;

            // 2. Vérifier le solde si c'est un débit du wallet
            const isDebit = type === 'withdrawal' || type === 'tontine_contribution' || type === 'saving_transfer';
            if (isDebit || paymentMethod === 'wallet') {
                // Si c'est un dépôt (remboursement), on ne vérifie JAMAIS le solde
                if (type !== 'deposit') {
                    const totalDebit = amount;
                    if (user.walletBalance < totalDebit) {
                        throw new AppError('Solde insuffisant dans le portefeuille', 400);
                    }
                    user.walletBalance -= totalDebit;
                }
            }

            // 3. Créditer le solde si c'est un crédit wallet
            if (type === 'deposit' || type === 'tontine_payout' || type === 'challenge_reward') {
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
                        type: (type === 'deposit' || type === 'tontine_payout' || type === 'challenge_reward') ? 'income' : 'expense',
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

            // 5. Audit Log
            await AuditService.record({
                userId: userId as any,
                action: type.toUpperCase(),
                resource: 'WALLET',
                resourceId: transactionRef,
                status: 'success',
                metadata: { amount, fees, netAmount, paymentMethod },
            });

            await session.commitTransaction();

            // 6. Notification (Hors transaction car non critique)
            NotificationService.sendToUser(userId, {
                title: 'Transaction réussie',
                body: `Votre transaction de ${amount} ${user.currency} a été traitée.`,
                category: 'transactional',
                translationKey: 'TRANSACTION_SUCCESS',
                translationData: { amount, type },
                data: { transactionRef, type },
            }).catch(err => logger.error(`Wallet Notification Error: ${err.message}`));

            return transaction[0];
        } catch (error: any) {
            await session.abortTransaction();
            logger.error(`Wallet Transaction Aborted: ${error.message}`);
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
