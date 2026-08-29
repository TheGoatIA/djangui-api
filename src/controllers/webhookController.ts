import { Request, Response, NextFunction } from 'express';
import stripe from '../config/stripe';
import { PaymentService } from '../services/paymentService';
import { WalletService } from '../services/walletService';
import Transaction from '../models/Transaction';
import { notchpayConfig } from '../config/notchpay';
import { verifyNotchPaySignature } from '../utils/cryptoUtils';
import { SlackService } from '../services/slackService';
import logger from '../utils/logger';
import { MonitoringService } from '../services/monitoringService';

// A sustained forgery attempt shouldn't spam Slack on every single request â€”
// this just keeps the alert to roughly once per 5-minute window per process,
// which is enough to get a human's attention without becoming its own noise.
let lastInvalidSignatureAlertAt = 0;
const INVALID_SIGNATURE_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export class WebhookController {
  static async stripeWebhook(req: Request, res: Response, next: NextFunction) {
    const sig = req.headers['stripe-signature'] as string;
    const startedAt = Date.now();
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        (req as any).rawBody || req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET || '',
      );
    } catch (err: any) {
      logger.error(`Stripe Webhook Error: ${err.message}`);
      MonitoringService.recordWebhookReceived('stripe', 'unknown', 'invalid_signature');
      MonitoringService.observeWebhookProcessingDuration('stripe', 'unknown', (Date.now() - startedAt) / 1000);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    let status: 'processed' | 'failed' = 'processed';

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      const reference = session.metadata.reference;

      try {
        await PaymentService.completePayment(reference, session.id);
      } catch (err: any) {
        logger.error(`Error completing payment via Stripe Webhook: ${err.message}`);
        status = 'failed';
      }
    }

    MonitoringService.recordWebhookReceived('stripe', event.type, status);
    MonitoringService.observeWebhookProcessingDuration('stripe', event.type, (Date.now() - startedAt) / 1000);

    res.json({ received: true });
  }

  static async notchpayWebhook(req: Request, res: Response, next: NextFunction) {
    const signature = req.headers['x-notchpay-signature'] as string;
    const startedAt = Date.now();

    // Verify against the exact raw bytes NotchPay signed (captured by app.ts's
    // express.json `verify` hook), not a re-serialization of the parsed body â€”
    // see cryptoUtils.verifyNotchPaySignature for why that matters.
    const rawBody = (req as any).rawBody || req.body;
    if (!verifyNotchPaySignature(rawBody, signature, notchpayConfig.webhookSecret || '')) {
      logger.warn('Invalid NotchPay webhook signature received');
      MonitoringService.recordWebhookReceived('notchpay', 'unknown', 'invalid_signature');
      MonitoringService.observeWebhookProcessingDuration('notchpay', 'unknown', (Date.now() - startedAt) / 1000);

      const now = Date.now();
      if (now - lastInvalidSignatureAlertAt > INVALID_SIGNATURE_ALERT_COOLDOWN_MS) {
        lastInvalidSignatureAlertAt = now;
        SlackService.sendSecurity(
          `ðŸ”’ *Signature de webhook NotchPay invalide dÃ©tectÃ©e* â€” tentative de falsification possible, ou secret webhook mal configurÃ©. IP: ${req.ip}`,
        ).catch((e: any) => logger.error(`Slack alert error: ${e.message}`));
      }

      return res.status(401).json({ message: 'Invalid signature' });
    }

    const data = req.body;
    let status: 'processed' | 'failed' = 'processed';

    if (data.event === 'payment.complete') {
      const reference = data.data.reference;
      try {
        await PaymentService.completePayment(reference);
      } catch (err: any) {
        logger.error(`Error completing payment via NotchPay Webhook: ${err.message}`);
        status = 'failed';
      }
    } else if (data.event === 'transfer.complete') {
      // Le transfert est confirmÃ© par NotchPay â€” marquer la transaction en base comme confirmÃ©e.
      // Note: WalletService.executeTransaction crÃ©e dÃ©jÃ  la transaction en 'completed' lors de l'initiation
      // (Mobile Money est quasi-instantanÃ©), mais ce webhook permet de tracer la confirmation opÃ©rateur
      // et de notifier l'utilisateur du succÃ¨s final.
      const reference = data.data.reference || data.data.metadata?.reference;
      try {
        const tx = await Transaction.findOneAndUpdate(
          { reference },
          {
            $set: {
              status: 'completed',
              'metadata.notchpayConfirmedAt': new Date().toISOString(),
              'metadata.notchpayStatus': 'confirmed',
            },
          },
          { new: true },
        );
        if (tx) {
          logger.info(`Transfer ${reference} confirmed by NotchPay operator.`);
        } else {
          logger.warn(`Transfer ${reference}: transaction not found for confirmation webhook.`);
        }
      } catch (confirmErr: any) {
        logger.error(`Failed to confirm transfer ${reference}: ${confirmErr.message}`);
        status = 'failed';
      }
    } else if (data.event === 'transfer.failed') {
      // The transfer payload now sends our internal reference at the top level
      // (see PayoutService.initiatePayout), but fall back to metadata.reference
      // in case NotchPay ever echoes it there instead for this event type.
      const reference = data.data.reference || data.data.metadata?.reference;
      logger.error(`Transfer ${reference} failed: ${data.data.reason}`);

      try {
        // Atomic status transition: only process refund if status transitions from non-failed to failed.
        // findOneAndUpdate with $ne guard prevents race conditions from duplicate webhook deliveries.
        const originalTx = await Transaction.findOneAndUpdate(
          { reference, status: { $ne: 'failed' } },
          {
            $set: {
              status: 'failed',
              'metadata.failureReason': data.data.reason,
              'metadata.failedAt': new Date().toISOString(),
            },
          },
          { new: false }, // Return the OLD doc to confirm it was actually updated
        );

        if (!originalTx) {
          // Either not found or already failed â€” idempotent, no action needed
          logger.warn(`Transfer ${reference}: skipping refund (already processed or not found)`);
        } else {
          // Atomically claimed the transition â€” safe to issue refund exactly once.
          // Refund amount + fees: the wallet was debited for the full amount
          // (withdrawal amount + Kauri fee), but `originalTx.amount` only stores
          // the net withdrawal amount (fees are tracked separately in
          // `originalTx.fees`) â€” refunding just `.amount` would silently let
          // Kauri keep the fee on a transfer that never actually happened.
          await WalletService.executeTransaction({
            userId: originalTx.userId.toString(),
            amount: originalTx.amount + (originalTx.fees || 0),
            type: 'deposit',
            description: `Remboursement transfert Ã©chouÃ© (${data.data.reason || 'Erreur opÃ©rateur'})`,
            paymentMethod: 'wallet',
            metadata: { originalReference: reference },
          });
          logger.info(`Refund processed for failed transfer: ${reference}`);
        }
      } catch (refundErr: any) {
        logger.error(
          `Critical: Failed to process refund for transfer ${reference}: ${refundErr.message}`,
        );
        // This previously was a log line only, despite the word "Critical" â€”
        // a user is left with a debited wallet and no refund until someone
        // notices. The NotchPay reconciliation job will retry this on its
        // next run, but a human should be told immediately, not just hope
        // the next cron pass fixes it silently.
        SlackService.sendAlert(
          `ðŸš¨ *Ã‰chec du remboursement automatique* pour le transfert \`${reference}\`\n*Erreur*: ${refundErr.message}\nLe portefeuille de l'utilisateur reste dÃ©bitÃ© â€” vÃ©rification manuelle requise (la rÃ©conciliation NotchPay retentera automatiquement, mais ne pas attendre sans vÃ©rifier).`,
        ).catch((e: any) => logger.error(`Slack alert error: ${e.message}`));
        status = 'failed';
      }
    }

    MonitoringService.recordWebhookReceived('notchpay', data.event || 'unknown', status);
    MonitoringService.observeWebhookProcessingDuration(
      'notchpay',
      data.event || 'unknown',
      (Date.now() - startedAt) / 1000,
    );

    res.json({ received: true });
  }
}

