import Payment from '../models/Payment';
import Transaction from '../models/Transaction';
import { notchpayApi, notchpayAdminApi } from '../config/notchpay';
import { PaymentService } from './paymentService';
import { WalletService } from './walletService';
import { SlackService } from './slackService';
import logger from '../utils/logger';

// Don't check a payment/transfer until it's had a real chance to complete
// normally via webhook — otherwise every run would "discover" things that are
// simply still in flight.
const PENDING_GRACE_MINUTES = 15;
// Bound the lookback window so the job stays fast and doesn't keep re-querying
// ancient rows forever; anything older than this is either already resolved
// or genuinely abandoned and needs a human, not an automated pass.
const LOOKBACK_HOURS = 48;
const BATCH_LIMIT = 200;

interface ReconciliationResult {
  paymentsChecked: number;
  paymentsHealed: number;
  paymentsMarkedFailed: number;
  transfersChecked: number;
  transfersConfirmed: number;
  transfersRefunded: number;
  errors: string[];
}

/**
 * Closes the gap the earlier fraud/sync audit flagged: the existing daily
 * "reconciliation" (ReconciliationService.checkInternalIntegrity) only checks
 * Kauri's own ledger against itself — it never asks NotchPay what actually
 * happened. This service does that: it polls NotchPay directly for any
 * payment/transfer that's been sitting locally without a webhook confirmation
 * past a grace period, and self-heals the two failure modes a lost webhook
 * causes — a completed deposit stuck as 'pending' forever, and a failed
 * withdrawal that was never refunded because its `transfer.failed` webhook
 * never arrived.
 *
 * NOTE: `GET /transfers/:reference` follows NotchPay's documented REST
 * convention (symmetric to the already-proven-working `GET /payments/:reference`
 * used in PaymentService.verifyTransaction), but has not been exercised against
 * a live NotchPay account in this codebase before now — verify it against a
 * sandbox transfer before relying on this in production. A wrong assumption
 * here fails safe: every NotchPay call is wrapped so a bad response is logged
 * and skipped, never acted on destructively.
 */
export class NotchPayReconciliationService {
  static async reconcile(): Promise<ReconciliationResult> {
    const results: ReconciliationResult = {
      paymentsChecked: 0,
      paymentsHealed: 0,
      paymentsMarkedFailed: 0,
      transfersChecked: 0,
      transfersConfirmed: 0,
      transfersRefunded: 0,
      errors: [],
    };

    await this.reconcilePayments(results);
    await this.reconcileTransfers(results);

    const needsAttention =
      results.paymentsHealed > 0 ||
      results.paymentsMarkedFailed > 0 ||
      results.transfersRefunded > 0 ||
      results.errors.length > 0;

    if (needsAttention) {
      const lines = [
        `🔄 *Réconciliation NotchPay*`,
        `Paiements vérifiés: ${results.paymentsChecked} | Auto-réparés (webhook manqué): ${results.paymentsHealed} | Marqués échoués: ${results.paymentsMarkedFailed}`,
        `Transferts vérifiés: ${results.transfersChecked} | Confirmés: ${results.transfersConfirmed} | Remboursés (webhook manqué): ${results.transfersRefunded}`,
      ];
      if (results.errors.length > 0) {
        lines.push(`⚠️ ${results.errors.length} erreur(s) de vérification :`);
        lines.push(...results.errors.slice(0, 5));
      }
      SlackService.sendNotification(
        lines.join('\n'),
        results.paymentsHealed > 0 || results.transfersRefunded > 0 || results.errors.length > 3,
      ).catch((e: any) => logger.error(`[Reconciliation] Slack alert failed: ${e.message}`));
    }

    logger.info(`[Reconciliation] NotchPay sync complete: ${JSON.stringify(results)}`);
    return results;
  }

  private static async reconcilePayments(results: ReconciliationResult) {
    const graceCutoff = new Date(Date.now() - PENDING_GRACE_MINUTES * 60 * 1000);
    const lookbackCutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

    const pendingPayments = await Payment.find({
      method: 'notchpay',
      status: 'pending',
      createdAt: { $gte: lookbackCutoff, $lte: graceCutoff },
    }).limit(BATCH_LIMIT);

    for (const payment of pendingPayments) {
      results.paymentsChecked++;
      try {
        const response = await notchpayApi.get(`/payments/${payment.externalReference}`);
        const status = response.data?.transaction?.status;

        if (status === 'complete' || status === 'completed') {
          // NotchPay says this was actually paid, but no webhook ever moved it
          // out of 'pending' locally — self-heal via the same code path a
          // webhook would use, so the wallet credit/idempotency guard is
          // identical either way.
          await PaymentService.completePayment(payment.reference);
          results.paymentsHealed++;
          logger.warn(
            `[Reconciliation] Payment ${payment.reference} was completed on NotchPay but still pending locally — auto-healed (webhook likely missed).`,
          );
        } else if (['failed', 'expired', 'canceled', 'cancelled'].includes(status)) {
          await Payment.updateOne(
            { _id: payment._id, status: 'pending' },
            {
              $set: {
                status: 'failed',
                'metadata.reconciledAt': new Date().toISOString(),
                'metadata.reconciledStatus': status,
              },
            },
          );
          results.paymentsMarkedFailed++;
        }
        // Anything else (still 'pending' on NotchPay's side too) is left
        // alone — it'll be re-checked on the next run within the lookback window.
      } catch (err: any) {
        // A single lookup failure (network blip, 404, unexpected response shape)
        // must never abort the batch or trigger a destructive fallback action —
        // just record it and move on to the next payment.
        const msg = `Payment ${payment.reference}: ${err.message}`;
        results.errors.push(msg);
        logger.error(`[Reconciliation] ${msg}`);
      }
    }
  }

  private static async reconcileTransfers(results: ReconciliationResult) {
    const graceCutoff = new Date(Date.now() - PENDING_GRACE_MINUTES * 60 * 1000);
    const lookbackCutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

    // Withdrawals are debited synchronously at initiation (PayoutService), so
    // a 'completed' Transaction here only means "the debit happened" — not
    // that NotchPay actually delivered the money. `notchpayConfirmedAt` is
    // only ever set by the transfer.complete webhook; its absence past the
    // grace window means the transfer is either still genuinely in flight, or
    // ITS webhook (success or failure) never arrived.
    const unconfirmedTransfers = await Transaction.find({
      type: 'withdrawal',
      status: 'completed',
      'metadata.notchpayConfirmedAt': { $exists: false },
      'metadata.reconciledAt': { $exists: false },
      createdAt: { $gte: lookbackCutoff, $lte: graceCutoff },
    }).limit(BATCH_LIMIT);

    for (const tx of unconfirmedTransfers) {
      results.transfersChecked++;
      try {
        const response = await notchpayAdminApi.get(`/transfers/${tx.reference}`);
        const status = response.data?.transfer?.status || response.data?.status;

        if (['complete', 'completed', 'success'].includes(status)) {
          await Transaction.updateOne(
            { _id: tx._id },
            {
              $set: {
                'metadata.notchpayConfirmedAt': new Date().toISOString(),
                'metadata.notchpayStatus': 'confirmed',
                'metadata.reconciledAt': new Date().toISOString(),
              },
            },
          );
          results.transfersConfirmed++;
        } else if (['failed', 'declined', 'cancelled', 'canceled'].includes(status)) {
          // Same atomic-claim-then-refund pattern as the transfer.failed
          // webhook handler (webhookController.ts) — the $ne guard means that
          // if the real webhook arrives before or after this job runs, only
          // one of the two can ever actually issue the refund.
          const claimed = await Transaction.findOneAndUpdate(
            { _id: tx._id, status: { $ne: 'failed' } },
            {
              $set: {
                status: 'failed',
                'metadata.failureReason': `Réconciliation: NotchPay indique "${status}"`,
                'metadata.failedAt': new Date().toISOString(),
                'metadata.reconciledAt': new Date().toISOString(),
              },
            },
            { new: false },
          );
          if (claimed) {
            await WalletService.executeTransaction({
              userId: claimed.userId.toString(),
              amount: claimed.amount + (claimed.fees || 0),
              type: 'deposit',
              description: 'Remboursement transfert échoué (détecté par réconciliation NotchPay)',
              paymentMethod: 'wallet',
              metadata: { originalReference: tx.reference, source: 'reconciliation' },
            });
            results.transfersRefunded++;
            logger.warn(
              `[Reconciliation] Transfer ${tx.reference} failed on NotchPay but no webhook ever arrived — auto-refunded.`,
            );
          }
        }
        // Still pending on NotchPay's side too — left for the next run.
      } catch (err: any) {
        const msg = `Transfer ${tx.reference}: ${err.message}`;
        results.errors.push(msg);
        logger.error(`[Reconciliation] ${msg}`);
      }
    }
  }
}
