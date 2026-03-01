import { Request, Response, NextFunction } from 'express';
import stripe from '../config/stripe';
import { PaymentService } from '../services/paymentService';
import { notchpayConfig } from '../config/notchpay';
import { verifyNotchPaySignature } from '../utils/cryptoUtils';
import logger from '../utils/logger';

export class WebhookController {
  static async stripeWebhook(req: Request, res: Response, next: NextFunction) {
    const sig = req.headers['stripe-signature'] as string;
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        (req as any).rawBody || req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET || '',
      );
    } catch (err: any) {
      logger.error(`Stripe Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const reference = session.metadata.reference;

      try {
        await PaymentService.completePayment(reference, session.id);
      } catch (err: any) {
        logger.error(`Error completing payment via Stripe Webhook: ${err.message}`);
      }
    }

    res.json({ received: true });
  }

  static async notchpayWebhook(req: Request, res: Response, next: NextFunction) {
    const signature = req.headers['x-notchpay-signature'] as string;

    if (!verifyNotchPaySignature(req.body, signature, notchpayConfig.webhookSecret || '')) {
      logger.warn('Invalid NotchPay webhook signature received');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const data = req.body;

    if (data.event === 'payment.complete') {
      const reference = data.data.reference;
      try {
        await PaymentService.completePayment(reference);
      } catch (err: any) {
        logger.error(`Error completing payment via NotchPay Webhook: ${err.message}`);
      }
    } else if (data.event === 'transfer.complete') {
      // Le transfert est fini, on pourrait mettre à jour le statut de la transaction
      // mais WalletService.executeTransaction l'a déjà mis en completed lors de l'initiation MoMo
      // car NotchPay Transfers est quasi instantané.
      // Ici on peut envoyer une notification de succès finale.
      logger.info(`Transfer ${data.data.reference} completed successfully`);
    } else if (data.event === 'transfer.failed') {
      const reference = data.data.reference;
      logger.error(`Transfer ${reference} failed: ${data.data.reason}`);

      // Logique de remboursement automatique
      const Transaction = require('../models/Transaction').default;
      const { WalletService } = require('../services/walletService');

      try {
        const originalTx = await Transaction.findOne({ reference });
        if (originalTx && originalTx.status !== 'failed') {
          await WalletService.executeTransaction({
            userId: originalTx.userId.toString(),
            amount: originalTx.amount, // Montant total (Net + Frais)
            type: 'deposit',
            description: `Remboursement transfert échoué (${data.data.reason || 'Erreur opérateur'})`,
            paymentMethod: 'wallet',
            metadata: { originalReference: reference },
          });

          originalTx.status = 'failed';
          originalTx.metadata = { ...originalTx.metadata, failureReason: data.data.reason };
          await originalTx.save();

          logger.info(`Refund processed for failed transfer: ${reference}`);
        }
      } catch (refundErr: any) {
        logger.error(
          `Critical: Failed to process refund for transfer ${reference}: ${refundErr.message}`,
        );
      }
    }

    res.json({ received: true });
  }
}
