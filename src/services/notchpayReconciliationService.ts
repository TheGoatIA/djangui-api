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
      SlackService.sendFinance(lines.join('\n')).catch((e: any) =>
        logger.error(`[Reconciliation] Slack alert failed: ${e.message}`),
      );
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
    // Wallet withdrawals are stored as type 'expense' + category 'withdrawal'
    // (WalletService) — querying type 'withdrawal' never matched a single one.
    // 'pending' is included: that is exactly the state an ambiguous NotchPay
    // error (5xx, timeout after send) leaves a withdrawal in.
    const unconfirmedTransfers = await Transaction.find({
      category: 'withdrawal',
      paymentMethod: 'wallet',
      status: { $in: ['completed', 'pending'] },
      'metadata.notchpayConfirmedAt': { $exists: false },
      'metadata.reconciledAt': { $exists: false },
      createdAt: { $gte: lookbackCutoff, $lte: graceCutoff },
    }).limit(BATCH_LIMIT);

    for (const tx of unconfirmedTransfers) {
      results.transfersChecked++;
      try {
        const outcome = await NotchPayReconciliationService.checkTransfer(tx);
        if (outcome === 'confirmed') results.transfersConfirmed++;
        if (outcome === 'refunded') results.transfersRefunded++;
      } catch (err: any) {
        const msg = `Transfer ${tx.reference}: ${err.message}`;
        results.errors.push(msg);
        logger.error(`[Reconciliation] ${msg}`);
      }
    }
  }

  /**
   * Asks NotchPay for the REAL state of one withdrawal and settles it:
   * complete → confirmed; failed → refunded (amount + fees) exactly once;
   * otherwise left untouched. Never re-sends money. Used by the reconciliation
   * job and by the admin "verify with operator" action (4-eyes approved).
   */
  static async checkTransfer(tx: any): Promise<'confirmed' | 'refunded' | 'pending' | 'unchanged'> {
    // NotchPay only resolves ITS id (trf.…): GET /transfers/<our ref> is a 404
    // (verified on the sandbox). The id is stored at payout time.
    const response = await notchpayAdminApi.get(
      `/transfers/${tx.externalReference || tx.reference}`,
    );
    const status = response.data?.transfer?.status || response.data?.status;

    if (['complete', 'completed', 'success'].includes(status)) {
      // Guard: a withdrawal already marked failed has been REFUNDED — never flip
      // it back to completed (the user would keep the refund AND the transfer).
      const r = await Transaction.updateOne(
        { _id: tx._id, status: { $ne: 'failed' } },
        {
          $set: {
            status: 'completed',
            'metadata.notchpayConfirmedAt': new Date().toISOString(),
            'metadata.notchpayStatus': 'confirmed',
            'metadata.reconciledAt': new Date().toISOString(),
          },
        },
      );
      if (r.modifiedCount === 0 && tx.status === 'failed') {
        logger.error(
          `[Reconciliation] 🚨 Transfer ${tx.reference} is COMPLETE on NotchPay but was already refunded — manual review required.`,
        );
        SlackService.sendAlert(
          `🚨 Retrait \`${tx.reference}\` : NotchPay indique "complete" alors qu'il a déjà été remboursé. Vérification manuelle requise.`,
        ).catch(() => undefined);
        return 'unchanged';
      }
      return 'confirmed';
    }

    if (['failed', 'declined', 'cancelled', 'canceled'].includes(status)) {
      // Claim + refund in ONE transaction (same pattern as the transfer.failed
      // webhook): whichever of the two runs first refunds, the other no-ops.
      const claimed = await WalletService.runInTransaction(async (session) => {
        const won = await Transaction.findOneAndUpdate(
          { _id: tx._id, status: { $ne: 'failed' } },
          {
            $set: {
              status: 'failed',
              'metadata.failureReason': `Réconciliation: NotchPay indique "${status}"`,
              'metadata.failedAt': new Date().toISOString(),
              'metadata.reconciledAt': new Date().toISOString(),
            },
          },
          { new: false, session },
        );
        if (!won) return false;
        await WalletService.executeTransaction(
          {
            userId: won.userId.toString(),
            amount: won.amount + (won.fees || 0),
            type: 'deposit',
            description: 'Remboursement transfert échoué (détecté par réconciliation NotchPay)',
            paymentMethod: 'wallet',
            metadata: { originalReference: tx.reference, source: 'reconciliation' },
          },
          { session },
        );
        return true;
      });
      if (claimed) {
        logger.warn(`[Reconciliation] Transfer ${tx.reference} failed on NotchPay — refunded.`);
        return 'refunded';
      }
      return 'unchanged';
    }
    return 'pending';
  }
}
