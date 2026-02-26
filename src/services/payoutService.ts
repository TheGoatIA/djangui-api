import { notchpayApi, notchpayAdminApi } from '../config/notchpay';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { WalletService } from './walletService';

export class PayoutService {
    /**
     * Initie un transfert d'argent (Retrait) via NotchPay
     */
    static async initiatePayout(userId: string, amount: number, data: {
        phone: string;
        provider: 'cm.orange' | 'cm.mtn';
        description?: string;
    }) {
        const user = await User.findById(userId);
        if (!user) throw new AppError('Utilisateur non trouvé', 404);

        // 1. Géo-fencing strict (Cameroun uniquement pour les retraits MoMo)
        if (user.country !== 'CM') {
            throw new AppError('Les retraits Mobile Money ne sont disponibles qu\'au Cameroun.', 400);
        }

        // 2. Double vérification KYC
        if (user.kycLevel !== 'verified') {
            throw new AppError('Vous devez avoir un compte vérifié (KYC) pour effectuer des retraits.', 403);
        }

        // 3. Vérification des fonds via WalletService (incluant les frais de 3%)
        const kauriFeePercent = user.subscription?.plan === 'premium' ? 0.015 : 0.03;
        const kauriFees = Math.max(100, amount * kauriFeePercent);
        const totalAmount = amount + kauriFees;

        // Tentative de débit via WalletService (ACID)
        const transaction = await WalletService.executeTransaction({
            userId,
            amount: totalAmount,
            type: 'withdrawal',
            description: data.description || 'Retrait MoMo Kauri',
            paymentMethod: 'wallet',
            fees: kauriFees,
            metadata: { phone: data.phone, provider: data.provider }
        });

        const providerMap: Record<string, string> = {
            'orange': 'cm.orange',
            'mtn': 'cm.mtn',
            'cm.orange': 'cm.orange',
            'cm.mtn': 'cm.mtn'
        };
        const providerKey = data.provider?.toLowerCase();
        const channel = providerMap[providerKey];
        if (!channel) {
            throw new AppError(`Fournisseur invalide : ${data.provider}. Utilisez 'orange' ou 'mtn'.`, 400);
        }

        const start = Date.now();
        const recipientPayload = {
            channel: channel,
            name: user.kycData?.fullName || `${user.firstName} ${user.lastName}`,
            phone: data.phone,
            account_number: data.phone
        };
        logger.debug(`NotchPay Recipient Payload: ${JSON.stringify(recipientPayload)}`);

        try {
            // STEP 1: Create or Get Recipient
            const recipientResponse = await notchpayAdminApi.post('/recipients', recipientPayload, {
                headers: { 'Content-Type': 'application/json' }
            });

            const recipientId = recipientResponse.data.recipient?.id || recipientResponse.data.id;
            if (!recipientId) {
                throw new Error('Could not retrieve recipient ID from NotchPay');
            }
            logger.info(`Recipient ID retrieved: ${recipientId}`);

            // STEP 2: Initiate Transfer
            const transferPayload = {
                amount: amount,
                currency: user.currency || 'XAF',
                recipient: recipientId,
                channel: channel, // Repeated channel field as required by the error log
                description: data.description || `Kauri Withdrawal to ${data.phone}`,
                reference: transaction.reference,
            };

            const response = await notchpayAdminApi.post('/transfers', transferPayload, {
                headers: { 'Content-Type': 'application/json' }
            });

            MonitoringService.recordPaymentGateway('notchpay', 'transfer', 'success');

            // According to doc, the ID/Ref is in transfer.reference or transfer.id
            const transferId = response.data.transfer?.reference || response.data.transfer?.id || response.data.id;
            return {
                status: 'pending',
                transferId,
                reference: transaction.reference,
                fees: kauriFees
            };
        } catch (error: any) {
            MonitoringService.recordPaymentGateway('notchpay', 'transfer', 'failure');
            const errorMessage = error.response?.data?.message || error.message;
            const errorDetails = error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : '';
            logger.error(`NotchPay Transfer Error: ${errorMessage} ${errorDetails}`);

            // Log full response data for catastrophic failures to pinpoint validation issues
            if (error.response?.data) {
                logger.debug(`NotchPay Full Error Response: ${JSON.stringify(error.response.data)}`);
            }

            // REMBOURSEMENT en cas d'échec immédiat de l'API
            await WalletService.executeTransaction({
                userId,
                amount: totalAmount,
                type: 'deposit',
                description: `Remboursement suite échec retrait (${error.message})`,
                paymentMethod: 'wallet',
                metadata: { originalReference: transaction.reference }
            });

            throw new AppError(`Échec de l'initialisation du transfert : ${error.message}`, 500);
        } finally {
            MonitoringService.observePaymentGatewayDuration(
                'notchpay',
                'transfer',
                (Date.now() - start) / 1000
            );
        }
    }
}
