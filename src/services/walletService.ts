import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import { AuditService } from './auditService';
import { NotificationService } from './notificationService';
import { MonitoringService } from './monitoringService';
import { FinancialAlertService } from './financialAlertService';
import { CurrencyService } from './currencyService';
import { isSubscriptionEntitled } from '../utils/subscription';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

// AML transaction limits per plan (in XAF / FCFA)
const AML_LIMITS = {
  free: {
    MAX_SINGLE_TRANSACTION: 50_000, // 50 000 FCFA par transaction
    MAX_DAILY_TOTAL: 100_000, // 100 000 FCFA par jour
  },
  premium: {
    MAX_SINGLE_TRANSACTION: 50_000, // 50 000 FCFA par transaction
    MAX_DAILY_TOTAL: 300_000, // 300 000 FCFA par jour
  },
};

/** Retourne les limites AML applicables selon le plan et la devise de l'utilisateur. */
export interface AMLLimits {
  MAX_SINGLE_TRANSACTION: number;
  MAX_DAILY_TOTAL: number;
  currency: string;
  symbol: string;
}

const getUserLimits = (user: {
  currency?: string;
  subscription?: { plan?: string; status?: string; endDate?: Date };
}): AMLLimits => {
  const isPremium = isSubscriptionEntitled(user.subscription);
  const baseLimits = isPremium ? AML_LIMITS.premium : AML_LIMITS.free;

  const userCurrency = (user.currency || 'XAF').toUpperCase();
  const rate = CurrencyService.getRate('XAF', userCurrency);
  const symbol = CurrencyService.getSymbol(userCurrency);

  const isZeroDecimal = [
    'XAF',
    'XOF',
    'JPY',
    'CLP',
    'GNF',
    'KRW',
    'PYG',
    'VND',
    'BIF',
    'DJF',
    'ISK',
    'KMF',
    'MGA',
    'RWF',
    'UGX',
    'VUV',
    'XPF',
  ].includes(userCurrency);
  const roundLimit = (val: number) =>
    isZeroDecimal ? Math.round(val) : Math.round(val * 100) / 100;

  return {
    MAX_SINGLE_TRANSACTION: roundLimit(baseLimits.MAX_SINGLE_TRANSACTION * rate),
    MAX_DAILY_TOTAL: roundLimit(baseLimits.MAX_DAILY_TOTAL * rate),
    currency: userCurrency,
    symbol,
  };
};

/**
 * Round a financial amount to 2 decimal places to avoid float precision errors.
 * For zero-decimal currencies (XAF, JPY) this is effectively Math.round().
 */
const roundAmount = (n: number): number => Math.round(n * 100) / 100;

export class WalletService {
  /**
   * Runs `fn` inside a MongoDB session/transaction, retrying automatically on
   * transient transaction errors (write conflicts, network blips) per the
   * MongoDB-recommended `withTransaction` retry pattern. Callers composing a
   * wallet operation with a related domain-document write (e.g. crediting a
   * goal, marking a tontine contribution paid) should fetch and mutate their
   * documents *inside* `fn` so a retry re-reads fresh state instead of
   * re-applying an in-memory mutation twice.
   */
  static async runInTransaction<T>(
    fn: (session: mongoose.ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let result: T = undefined as any;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      session.endSession();
    }
  }

  /**
   * Effectue un transfert de fonds sécurisé entre deux entités (ou wallet -> banque)
   * Utilise les transactions MongoDB pour garantir l'atomicité.
   *
   * Pass `options.session` to participate in a transaction already started by
   * the caller (e.g. via `runInTransaction`) so the wallet write and a related
   * domain-document write commit or roll back together. Without it, this
   * method owns and retries its own transaction.
   */
  static async executeTransaction(
    data: {
      userId: string;
      amount: number;
      type:
        | 'deposit'
        | 'withdrawal'
        | 'tontine_contribution'
        | 'tontine_payout'
        | 'tontine_social_fund'
        | 'tontine_absence_fee'
        | 'saving_transfer'
        | 'challenge_reward';
      // Reporting-only label, decoupled from `type` (which drives the AML/
      // isDebit/isCredit business logic below and must stay a closed enum).
      // Lets callers that all share `type: 'saving_transfer'` — goal
      // contributions, challenge stakes, investment purchases — still show up
      // as distinct, human-readable categories in spending analysis instead
      // of being merged into one opaque "saving_transfer" bucket. Defaults to
      // `type` when omitted, preserving prior behavior for every other caller.
      category?: string;
      description: string;
      paymentMethod: 'stripe' | 'notchpay' | 'wallet';
      reference?: string;
      externalReference?: string;
      fees?: number;
      metadata?: Record<string, any>;
      silent?: boolean;
    },
    options?: { session?: mongoose.ClientSession },
  ) {
    const externalSession = options?.session;

    const {
      userId,
      amount,
      type,
      category,
      description,
      paymentMethod,
      reference,
      externalReference,
      fees = 0,
      metadata,
      silent = false,
    } = data;

    const run = async (session: mongoose.ClientSession) => {
      // Guard: amount must be a finite positive number
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new AppError('Montant invalide', 400);
      }

      // 1. Récupérer l'utilisateur (nécessaire avant les vérifications AML pour connaître le plan)
      const user = await User.findById(userId).session(session);
      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      // Limites AML selon le plan de l'utilisateur
      const limits = getUserLimits(user);
      const planLabel = isSubscriptionEntitled(user.subscription) ? 'premium' : 'gratuit';

      // AML caps apply to the money actually MOVED (net of Kauri fees). Fees are
      // Kauri revenue, not funds leaving the platform: counting them meant a
      // 50 000 XAF withdrawal (+1 500 fees) was refused although 50 000 is the
      // advertised maximum. Stored Transaction.amount is also the net amount, so
      // the daily sum below and this check now use the same basis.
      const amlAmount = roundAmount(amount - (fees || 0));

      // The single-operation cap targets money ENTERING (external deposit) or
      // LEAVING a wallet. Internal credits — a tontine pot paid to its winner,
      // a challenge reward, a refund — redistribute funds that already passed
      // the cap on the way in. Capping them blocked every tontine whose pot
      // exceeded 50 000 XAF: rotateTurn rolled back forever, funds stranded.
      const isInternalCredit =
        type === 'tontine_payout' ||
        type === 'challenge_reward' ||
        (type === 'deposit' && paymentMethod === 'wallet');

      // AML: limite par transaction unique
      if (!isInternalCredit && amlAmount > limits.MAX_SINGLE_TRANSACTION) {
        throw new AppError(
          `Montant dépasse la limite par transaction pour les comptes ${planLabel} (${limits.MAX_SINGLE_TRANSACTION.toLocaleString()} ${limits.symbol})`,
          400,
        );
      }

      // AML: daily cumulative limit for debits
      const isDebit =
        type === 'withdrawal' ||
        type === 'tontine_contribution' ||
        type === 'tontine_social_fund' ||
        type === 'tontine_absence_fee' ||
        type === 'saving_transfer';
      const isCredit =
        type === 'deposit' || type === 'tontine_payout' || type === 'challenge_reward';

      if (isDebit) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const dailyTotal = await Transaction.aggregate([
          {
            $match: {
              userId: mongoose.Types.ObjectId.isValid(userId)
                ? new mongoose.Types.ObjectId(userId)
                : userId,
              // AML: every REAL wallet debit of the day, whatever its category.
              // System debits are always stored as type 'expense' + paymentMethod
              // 'wallet'. Restricting to the wallet matters: the user's manually
              // recorded budget expenses (rent paid in cash…) are also 'expense'
              // rows and used to count here, blocking legitimate wallet operations.
              type: 'expense',
              paymentMethod: 'wallet',
              // A withdrawal stays 'pending' while NotchPay processes it: it must
              // count too, or rapid successive withdrawals bypass the daily cap.
              status: { $in: ['completed', 'pending'] },
              date: { $gte: startOfDay },
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]).session(session);

        const todaySpent = dailyTotal[0]?.total || 0;
        if (todaySpent + amlAmount > limits.MAX_DAILY_TOTAL) {
          throw new AppError(
            `Limite journalière de transactions atteinte pour les comptes ${planLabel} (${limits.MAX_DAILY_TOTAL.toLocaleString()} ${limits.symbol}/jour)`,
            400,
          );
        }
      }

      // Use rounded amounts to prevent float precision drift
      const safeAmount = roundAmount(amount);
      const safeFees = roundAmount(fees);
      const netAmount = roundAmount(safeAmount - safeFees);
      const transactionRef = reference || `TXN-${uuidv4().split('-')[0].toUpperCase()}`;

      // On débite seulement si c'est un type de débit explicite
      // OU si le mode est wallet ET que ce n'est PAS un type de crédit
      if (isDebit || (paymentMethod === 'wallet' && !isCredit)) {
        const totalDebit = safeAmount;
        if (user.walletBalance < totalDebit) {
          MonitoringService.recordNegativeBalanceAttempt('standard');
          throw new AppError('Solde insuffisant dans le portefeuille', 400);
        }
        user.walletBalance = roundAmount(user.walletBalance - totalDebit);
      }

      // 3. Créditer le solde si c'est un crédit wallet
      if (isCredit) {
        user.walletBalance = roundAmount(user.walletBalance + netAmount);
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
            category: category || type,
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

      return {
        transactionDoc: transaction[0],
        safeAmount,
        safeFees,
        netAmount,
        transactionRef,
        userCurrency: user.currency,
      };
    };

    try {
      const outcome = externalSession
        ? await run(externalSession)
        : await this.runInTransaction(run);

      const { transactionDoc, safeAmount, safeFees, netAmount, transactionRef, userCurrency } =
        outcome;

      MonitoringService.recordTransaction(type, 'success', userCurrency || 'XAF', safeAmount);
      logger.info(
        `[FINTECH] Transaction ${transactionRef} successful for user ${userId}. Amount: ${amount}, Type: ${type}`,
      );

      // Audit log & post-success side effects. These are non-critical and are
      // deliberately kept outside the DB transaction. When an external
      // session is used, the caller's own transaction hasn't committed yet at
      // this point, so we defer them until the caller confirms its commit
      // (via the `_postCommit` hook attached below) instead of firing a
      // "transaction successful" notification for a change that might still
      // roll back.
      const postCommit = async () => {
        await AuditService.recordSync({
          userId: userId as any,
          action: type.toUpperCase(),
          resource: 'WALLET',
          resourceId: transactionRef,
          status: 'success',
          metadata: { amount: safeAmount, fees: safeFees, netAmount, paymentMethod },
        });

        FinancialAlertService.monitorTransaction({
          userId,
          amount: safeAmount,
          type,
          reference: transactionRef,
          status: 'success',
        }).catch((err) => logger.error(`Alert Monitoring Error: ${err.message}`));

        if (!silent) {
          NotificationService.sendToUser(userId, {
            title: '',
            body: '',
            category: 'transactional',
            translationKey: 'TRANSACTION_SUCCESS',
            translationData: { amount: safeAmount, currency: userCurrency, type },
            data: { transactionRef, type },
          }).catch((err) => logger.error(`Wallet Notification Error: ${err.message}`));
        }
      };

      if (externalSession) {
        (transactionDoc as any)._postCommit = postCommit;
      } else {
        await postCommit();
      }

      return transactionDoc;
    } catch (error: any) {
      MonitoringService.recordTransaction(data.type, 'failure', 'XAF', roundAmount(data.amount));
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
    }
  }

  /** AML limits applicable to this user (plan + currency). */
  static getLimits(user: Parameters<typeof getUserLimits>[0]): AMLLimits {
    return getUserLimits(user);
  }

  /**
   * Refuses, BEFORE the customer is charged, an incoming amount the wallet
   * could never credit. Without this check a deposit above the AML
   * single-transaction cap was accepted at initialization, paid at NotchPay,
   * then rejected by executeTransaction at completion: the transaction rolled
   * back, the payment stayed 'pending' forever — money taken, never credited.
   */
  static assertCreditAllowed(user: Parameters<typeof getUserLimits>[0], amount: number): void {
    const limits = getUserLimits(user);
    if (amount > limits.MAX_SINGLE_TRANSACTION) {
      throw new AppError(
        `Montant maximum par recharge : ${limits.MAX_SINGLE_TRANSACTION.toLocaleString()} ${limits.symbol}.`,
        400,
      );
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
