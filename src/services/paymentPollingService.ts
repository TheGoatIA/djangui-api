import Payment from '../models/Payment';
import { PaymentService } from './paymentService';
import logger from '../utils/logger';

/**
 * Confirmation des paiements SANS webhook (« polling »).
 *
 * Quand les webhooks Stripe/NotchPay ne sont pas (encore) configurés, rien ne
 * prévient l'API qu'un paiement a abouti. Ce service interroge activement le
 * fournisseur pour chaque paiement `pending` récent et le finalise via
 * PaymentService.completePayment — exactement le même chemin que le webhook
 * (garde d'idempotence atomique : aucun risque de double crédit si un webhook
 * arrive plus tard, ou si le mobile appelle /payments/verify en parallèle).
 *
 * Cadence (déclenchée chaque minute par CronService, instance 0 uniquement) :
 *  - paiement < 10 min : vérifié à chaque passage (le client est en train de payer)
 *  - paiement plus ancien : au plus une fois toutes les 10 min
 *  - fenêtre de 48 h ; au-delà, c'est un cas humain (voir la réconciliation 30 min)
 */
const MIN_AGE_MS = 20 * 1000; // laisse au fournisseur le temps de créer la transaction
const FAST_WINDOW_MS = 10 * 60 * 1000;
const SLOW_INTERVAL_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

const TERMINAL_FAILURE = ['failed', 'expired', 'canceled', 'cancelled'];

export interface PollingResult {
  checked: number;
  completed: number;
  markedFailed: number;
  errors: number;
}

export class PaymentPollingService {
  private static running = false;

  static async pollPendingPayments(now: Date = new Date()): Promise<PollingResult> {
    const result: PollingResult = { checked: 0, completed: 0, markedFailed: 0, errors: 0 };

    // Garde de ré-entrance : un passage lent (fournisseur qui répond mal) ne doit
    // pas se chevaucher avec le suivant.
    if (this.running) return result;
    this.running = true;

    try {
      const candidates = await Payment.find({
        method: { $in: ['notchpay', 'stripe'] },
        status: 'pending',
        externalReference: { $exists: true, $ne: null },
        createdAt: {
          $gte: new Date(now.getTime() - LOOKBACK_MS),
          $lte: new Date(now.getTime() - MIN_AGE_MS),
        },
      })
        .sort({ createdAt: -1 })
        .limit(BATCH_LIMIT);

      for (const payment of candidates) {
        const ageMs = now.getTime() - new Date((payment as any).createdAt).getTime();
        const lastPolled = (payment as any).metadata?.lastPolledAt
          ? new Date((payment as any).metadata.lastPolledAt).getTime()
          : 0;
        const due = ageMs < FAST_WINDOW_MS || now.getTime() - lastPolled >= SLOW_INTERVAL_MS;
        if (!due) continue;

        result.checked++;
        try {
          const outcome = await PaymentService.verifyTransaction(payment.reference);
          if (outcome.status === 'completed') {
            result.completed++;
            logger.info(`[PaymentPolling] ${payment.reference} confirmé par le fournisseur`);
          } else if (TERMINAL_FAILURE.includes(String(outcome.status).toLowerCase())) {
            const upd = await Payment.updateOne(
              { _id: payment._id, status: 'pending' },
              {
                $set: {
                  status: 'failed',
                  'metadata.polledStatus': outcome.status,
                  'metadata.lastPolledAt': now.toISOString(),
                },
              },
            );
            if (upd.modifiedCount > 0) result.markedFailed++;
          } else {
            await Payment.updateOne(
              { _id: payment._id, status: 'pending' },
              { $set: { 'metadata.lastPolledAt': now.toISOString() } },
            );
          }
        } catch (err: any) {
          // Une erreur isolée (réseau, 502 du fournisseur) ne doit ni interrompre le
          // lot ni déclencher d'action destructive : on réessaiera au prochain passage.
          result.errors++;
          logger.warn(`[PaymentPolling] ${payment.reference}: ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }

    if (result.completed || result.markedFailed || result.errors) {
      logger.info(`[PaymentPolling] ${JSON.stringify(result)}`);
    }
    return result;
  }
}
