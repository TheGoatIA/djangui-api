import stripe from '../config/stripe';
import { notchpayApi } from '../config/notchpay';
import Payment from '../models/Payment';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { AuditService } from './auditService';
import { SlackService } from './slackService';
import { MonitoringService } from './monitoringService';
import { WalletService } from './walletService';
import { InvoiceService } from './invoiceService';
import { FeatureFlagService } from './featureFlagService';
import { FraudService } from './fraudService';
import { NotificationService } from './notificationService';
import { CurrencyService } from './currencyService';
import PlanConfig from '../models/PlanConfig';
import { computeNewEndDate, isSubscriptionEntitled, PaidPlan } from '../utils/subscription';

export class PaymentService {
  /**
   * Currencies that are expressed as whole units with no decimals (zero-decimal).
   * Source: https://stripe.com/docs/currencies#zero-decimal
   * IMPORTANT: If a currency is missing here, Stripe receives `amount * 100`
   * instead of `amount`, causing a 100x over-charge. Keep this list in sync
   * with Stripe's official documentation on every currency addition.
   */
  private static readonly ZERO_DECIMAL_CURRENCIES = [
    'BIF', // Franc burundais
    'CLP', // Peso chilien
    'DJF', // Franc djiboutien
    'GNF', // Franc guinéen
    'ISK', // Couronne islandaise
    'JPY', // Yen japonais
    'KMF', // Franc comorien
    'KRW', // Won coréen
    'MGA', // Ariary malgache
    'PYG', // Guaraní paraguayen
    'RWF', // Franc rwandais
    'UGX', // Shilling ougandais
    'VND', // Dong vietnamien
    'VUV', // Vatu vanuatuan
    'XAF', // Franc CFA BEAC (Cameroun, Congo, Gabon...)
    'XOF', // Franc CFA BCEAO (Côte d'Ivoire, Sénégal...)
    'XPF', // Franc CFP (Polynésie française)
  ];

  /**
   * Format amount for Stripe/NotchPay based on currency
   */
  private static formatAmount(amount: number, currency: string): number {
    const isZeroDecimal = this.ZERO_DECIMAL_CURRENCIES.includes(currency.toUpperCase());
    return isZeroDecimal ? Math.round(amount) : Math.round(amount * 100);
  }

  /**
   * Authoritative, server-side Premium subscription price by country (mirrors the
   * display-only pricing table in the mobile app's PaymentService.getSubscriptionPrice).
   * MUST be used instead of any client-supplied amount for `type === 'subscription'`,
   * otherwise a client can request an arbitrary (e.g. near-zero) checkout amount and
   * still be granted Premium once the payment completes.
   */
  private static getBusinessSubscriptionPrice(countryCode?: string | null): {
    amount: number;
    currency: string;
  } {
    switch (countryCode) {
      case 'FR':
      case 'BE':
      case 'DE':
      case 'IT':
      case 'ES':
        return { amount: 12.0, currency: 'EUR' };
      case 'US':
      case 'CA':
      case 'GB':
        return { amount: 15.0, currency: 'USD' };
      case 'CM':
      default:
        return { amount: 5000.0, currency: 'XAF' };
    }
  }

  private static getSubscriptionPrice(countryCode?: string | null): {
    amount: number;
    currency: string;
  } {
    switch (countryCode) {
      case 'FR':
      case 'BE':
      case 'DE':
      case 'IT':
      case 'ES':
        return { amount: 5.0, currency: 'EUR' };
      case 'US':
      case 'CA':
      case 'GB':
        return { amount: 6.0, currency: 'USD' };
      case 'CM':
      default:
        return { amount: 2000.0, currency: 'XAF' };
    }
  }

  /**
   * Resolve the amount to charge for `plan`, server-side.
   *
   * The admin edits plan prices in the plans screen (PlanConfig), and that is also
   * what the mobile app displays — so the charge must come from the same source,
   * otherwise users are billed a different amount than the one they were shown.
   * The hardcoded table is kept only as a fallback (plan missing/inactive/price <= 0).
   */
  static async resolvePlanPrice(
    plan: PaidPlan,
    countryCode?: string | null,
  ): Promise<{ amount: number; currency: string }> {
    const fallback =
      plan === 'business'
        ? this.getBusinessSubscriptionPrice(countryCode)
        : this.getSubscriptionPrice(countryCode);
    try {
      const config = await PlanConfig.findOne({ slug: plan, isActive: true }).lean();
      const configured = (config?.pricing?.monthly as any)?.[fallback.currency];
      if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return { amount: configured, currency: fallback.currency };
      }
    } catch (err: any) {
      logger.warn(`Plan price lookup failed for ${plan}, using fallback: ${err.message}`);
    }
    return fallback;
  }

  /**
   * Create a Stripe Checkout Session for subscription or deposit
   */
  static async createStripeSession(
    userId: any,
    clientAmount: number,
    type: 'deposit' | 'subscription',
    plan: 'premium' | 'business' = 'premium',
  ) {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    // Real-money kill-switch: when the admin has switched the platform to
    // virtual/simulation mode, no real card charge should be possible either —
    // otherwise a user could deposit/subscribe with real money while
    // withdrawals stay blocked, leaving funds stuck with no way out.
    if (!(await FeatureFlagService.isRealMoneyEnabled())) {
      throw new AppError(
        'Les paiements réels sont actuellement désactivés (Mode Portefeuille Virtuel / Simulation).',
        400,
      );
    }

    // Launch scope: real money currently starts in Cameroon only, wherever the
    // user actually is (see FeatureFlagService.getRealMoneyCountries).
    if (!(await FeatureFlagService.isCountryAllowedForRealMoney(user.country))) {
      throw new AppError(
        'Les paiements réels ne sont pas encore disponibles dans votre pays.',
        400,
      );
    }

    // Recharge (deposit) money into the wallet is exclusively via NotchPay
    // Mobile Money for now — Stripe is only used for subscription payments.
    if (type === 'deposit') {
      throw new AppError(
        'La recharge du portefeuille se fait uniquement via Mobile Money (NotchPay) pour le moment.',
        400,
      );
    }

    const reference = `STP-${uuidv4().split('-')[0].toUpperCase()}`;

    // For subscriptions, the price is a fixed, server-determined amount based on the
    // user's country — never trust a client-supplied amount for this. For deposits,
    // the user genuinely chooses how much to add to their own wallet, so the
    // client-supplied amount is what's actually charged and credited, which is safe.
    const { amount, currency } =
      type === 'subscription'
        ? await this.resolvePlanPrice(plan, user.country)
        : { amount: clientAmount, currency: user.currency || 'USD' };

    let session; // Declare session outside try block for wider scope
    const start = Date.now();
    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: currency.toLowerCase(),
              product_data: {
                name:
                  type === 'subscription'
                    ? `Kauri ${plan === 'business' ? 'Super Premium (Business)' : 'Premium'}`
                    : 'Wallet Deposit',
              },
              unit_amount: this.formatAmount(amount, currency),
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`}/payment/success?ref=${reference}`,
        cancel_url: `${process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`}/payment/cancel`,
        customer_email: user.email,
        client_reference_id: userIdStr,
        metadata: {
          userId: userIdStr,
          type,
          reference,
          plan,
        },
      });
      MonitoringService.recordPaymentGateway('stripe', 'create_session', 'success');

      await Payment.create({
        userId: userIdStr,
        amount,
        currency,
        method: 'stripe',
        type,
        reference,
        status: 'pending',
        externalReference: session.id,
        metadata: { plan },
      });

      // Audit Log for payment initiation
      AuditService.record({
        userId,
        action: 'INIT_PAYMENT',
        resource: 'PAYMENT',
        resourceId: reference,
        status: 'success',
        metadata: { method: 'stripe', amount, type },
      });

      return { url: session.url, reference };
    } catch (error: any) {
      MonitoringService.recordPaymentGateway('stripe', 'create_session', 'failure');
      throw error;
    } finally {
      MonitoringService.observePaymentGatewayDuration(
        'stripe',
        'create_session',
        (Date.now() - start) / 1000,
      );
    }
  }

  /**
   * Initialize a NotchPay payment (Restricted to Cameroon)
   */
  static async initializeNotchPay(
    userId: any,
    clientAmount: number,
    type: 'deposit' | 'subscription',
    phone?: string,
    plan: 'premium' | 'business' = 'premium',
  ) {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    // Real-money kill-switch — see the equivalent guard in createStripeSession.
    if (!(await FeatureFlagService.isRealMoneyEnabled())) {
      throw new AppError(
        'Les paiements réels sont actuellement désactivés (Mode Portefeuille Virtuel / Simulation).',
        400,
      );
    }

    // Geo-fencing: launch scope is Cameroon-only for now (admin-editable allowlist,
    // see FeatureFlagService.getRealMoneyCountries).
    if (!(await FeatureFlagService.isCountryAllowedForRealMoney(user.country))) {
      throw new AppError('NotchPay is only available for users in Cameroon.', 400);
    }

    // Phone validation: NotchPay requires a valid phone number
    const finalPhone = phone || user.phone;
    if (!finalPhone) {
      throw new AppError(
        'A phone number is required for NotchPay. Please provide it or update your profile.',
        400,
      );
    }

    // Basic format check for NotchPay (must be valid phone number, e.g. +2376XXXXXXXX or 6XXXXXXXX)
    const sanitizedPhone = finalPhone.replace(/[\s\-()]/g, '');
    if (!/^\+?[1-9]\d{6,14}$/.test(sanitizedPhone)) {
      throw new AppError(
        'Numéro de téléphone invalide pour NotchPay. Veuillez fournir un numéro au format international (ex: +237 6XXXXXXXX).',
        400,
      );
    }

    // Fraud screening: deposits previously had zero fraud assessment (only
    // withdrawals were checked) — velocity and deposit-clustering rules now
    // apply here too. See FraudService for the exact heuristics.
    if (type === 'deposit') {
      const fraud = await FraudService.assess(
        userIdStr,
        clientAmount,
        'deposit',
        user.currency || 'XAF',
      );
      if (fraud.block) {
        throw new AppError(
          'Opération temporairement suspendue par notre système de sécurité. Veuillez contacter le support.',
          403,
        );
      }
    }

    const reference = `NTP-${uuidv4().split('-')[0].toUpperCase()}`;

    // Same rule as Stripe: subscription price is fixed server-side, never client-supplied.
    const { amount, currency } =
      type === 'subscription'
        ? await this.resolvePlanPrice(plan, user.country)
        : { amount: clientAmount, currency: user.currency || 'XAF' };

    const start = Date.now();
    try {
      const response = await notchpayApi.post('/payments', {
        amount: this.formatAmount(amount, currency),
        currency: currency,
        customer: {
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          phone: finalPhone,
        },
        description:
          type === 'subscription'
            ? `Abonnement Kauri ${plan === 'business' ? 'Super Premium (Business)' : 'Premium'}`
            : 'Recharge Portefeuille',
        reference,
        callback: `${process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`}/payment/success?ref=${reference}`,
      });

      MonitoringService.recordPaymentGateway('notchpay', 'initialize', 'success');

      await Payment.create({
        userId: userIdStr,
        amount,
        currency,
        method: 'notchpay',
        type,
        reference,
        status: 'pending',
        externalReference: response.data.transaction.reference,
        metadata: { plan },
      });

      // Audit Log for payment initiation
      AuditService.record({
        userId,
        action: 'INIT_PAYMENT',
        resource: 'PAYMENT',
        resourceId: reference,
        status: 'success',
        metadata: { method: 'notchpay', amount, type },
      });

      return {
        url: response.data.authorization_url,
        reference,
      };
    } catch (error: any) {
      MonitoringService.recordPaymentGateway('notchpay', 'initialize', 'failure');
      logger.error(
        `NotchPay initialization error: ${error.response?.data?.message || error.message}`,
      );
      throw new AppError('Payment initialization failed', 500);
    } finally {
      MonitoringService.observePaymentGatewayDuration(
        'notchpay',
        'initialize',
        (Date.now() - start) / 1000,
      );
    }
  }

  /**
   * Complete payment (usually called via webhook).
   *
   * The status transition and the wallet credit / premium upgrade are committed
   * together in one Mongo transaction. Previously the status flip to 'completed'
   * was persisted first, then the wallet credit attempted separately — if the
   * credit failed (AML single-transaction limit, transient DB error), the
   * customer had already been charged by Stripe/NotchPay but the Payment record
   * was permanently stuck as 'completed' with no wallet credit and no retry path
   * (every future webhook retry / verifyTransaction call would see 'completed'
   * and no-op). Wrapping both in one transaction means a failed credit rolls
   * back the status too, leaving the payment 'pending' and genuinely retriable.
   */
  static async completePayment(reference: string, externalRef?: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      // Atomic status transition: only proceed if the payment was NOT already
      // completed. The status guard prevents two near-simultaneous webhook
      // deliveries (a routine occurrence with Stripe/NotchPay retries) from both
      // passing a check-then-act and crediting the wallet twice.
      const update: Record<string, any> = { status: 'completed', completedAt: new Date() };
      if (externalRef) update.externalReference = externalRef;

      const payment = await Payment.findOneAndUpdate(
        { reference, status: { $ne: 'completed' } },
        { $set: update },
        { new: true, session },
      );

      if (!payment) {
        const existing = await Payment.findOne({ reference }).session(session);
        if (!existing) throw new AppError('Payment not found', 404);
        // Already completed by a previous (possibly concurrent) call — idempotent no-op.
        return { payment: existing, alreadyCompleted: true, walletTransaction: null };
      }

      let walletTransaction: any = null;
      if (payment.type === 'deposit') {
        walletTransaction = await WalletService.executeTransaction(
          {
            userId: payment.userId.toString(),
            amount: payment.amount,
            type: 'deposit',
            description: 'Recharge Portefeuille Kauri',
            paymentMethod: payment.method,
            externalReference: payment.externalReference,
            reference: payment.reference,
          },
          { session },
        );
      } else if (payment.type === 'subscription') {
        // Never infer the tier from the amount (prices differ per currency, so a
        // 12 EUR business payment used to be read as "premium"). Payments always
        // carry metadata.plan; anything unexpected is a hard failure that rolls the
        // whole transaction back (payment stays 'pending' and recoverable) rather
        // than silently granting the wrong tier — or downgrading to 'free'.
        const targetPlan = payment.metadata?.plan;
        if (targetPlan !== 'premium' && targetPlan !== 'business') {
          throw new AppError(
            `Payment ${reference} has no valid subscription plan (got "${targetPlan}")`,
            422,
          );
        }
        logger.info(`Upgrading user ${payment.userId} to ${targetPlan}...`);

        const subscriber = await User.findById(payment.userId).session(session);
        if (!subscriber) throw new AppError('User not found', 404);

        const now = new Date();
        await User.findByIdAndUpdate(
          payment.userId,
          {
            'subscription.plan': targetPlan,
            'subscription.status': 'active',
            'subscription.startDate':
              subscriber.subscription?.plan === targetPlan &&
              isSubscriptionEntitled(subscriber.subscription)
                ? subscriber.subscription?.startDate || now
                : now,
            'subscription.endDate': computeNewEndDate(subscriber.subscription, targetPlan),
          },
          { session },
        );
      }

      return { payment, alreadyCompleted: false, walletTransaction };
    });

    const { payment, alreadyCompleted, walletTransaction } = result;
    if (alreadyCompleted) {
      return payment;
    }

    MonitoringService.recordPaymentGateway(payment.method || 'unknown', 'complete', 'success');

    // Post-commit side effects: the transaction above has committed, so it's now
    // safe to generate invoices / fire the wallet transaction's own notification.
    if (payment.type === 'deposit' && walletTransaction) {
      (walletTransaction as any)
        ._postCommit?.()
        .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));
      await InvoiceService.generateForTransaction(walletTransaction._id.toString());
    } else if (payment.type === 'subscription') {
      await InvoiceService.generateForPayment(payment._id.toString());

      const planName =
        payment.metadata?.plan === 'business' ? 'Super Premium (Business)' : 'Premium';
      NotificationService.sendToUser(payment.userId.toString(), {
        title: 'Abonnement activé 🌟',
        body: `Votre abonnement Kauri ${planName} est actif. Merci pour votre confiance !`,
        category: 'transactional',
        data: { reference, type: 'subscription_success' },
      }).catch((err: any) => logger.error(`Notification Error: ${err.message}`));
    }

    // Audit Log for payment completion — awaited (F21): this event backs the
    // AML/financial audit trail and must not be lost silently on a transient
    // DB error the caller never learns about.
    await AuditService.recordSync({
      userId: payment.userId as any,
      action: 'COMPLETE_PAYMENT',
      resource: 'PAYMENT',
      resourceId: reference,
      status: 'success',
      metadata: { type: payment.type, amount: payment.amount },
    });

    // Notify Slack
    SlackService.sendTransaction(
      `💰 *Payment Completed*\n*User ID*: ${payment.userId}\n*Amount*: ${payment.amount} ${payment.currency}\n*Type*: ${payment.type}\n*Reference*: ${reference}`,
    );

    return payment;
  }

  /**
   * Manually verify transaction status with provider.
   * @param reference Internal payment reference
   * @param requestingUserId If provided, enforces ownership — only the payment owner can verify
   */
  static async verifyTransaction(reference: string, requestingUserId?: string) {
    const payment = await Payment.findOne({ reference });
    if (!payment) throw new AppError('Payment not found', 404);

    // Ownership check: prevent IDOR — user A cannot verify user B's payment
    if (requestingUserId && payment.userId.toString() !== requestingUserId.toString()) {
      throw new AppError('Access denied', 403);
    }

    if (payment.status === 'completed') {
      return { status: 'completed', payment };
    }

    let isPaid = false;
    let externalStatus = 'pending';

    const start = Date.now();
    try {
      if (payment.method === 'notchpay') {
        // Verify with NotchPay API
        const response = await notchpayApi.get(`/payments/${payment.externalReference}`);
        const transaction = response.data.transaction;
        externalStatus = transaction.status;

        if (transaction.status === 'complete' || transaction.status === 'completed') {
          isPaid = true;
        }
        MonitoringService.recordPaymentGateway('notchpay', 'verify', 'success');
      } else if (payment.method === 'stripe') {
        // Verify with Stripe API
        const session = await stripe.checkout.sessions.retrieve(payment.externalReference!);
        // A Checkout Session that expired unpaid is terminal: report it as such so the
        // polling job can close the payment instead of re-checking it for 48 h.
        externalStatus = session.status === 'expired' ? 'expired' : session.payment_status;

        if (session.payment_status === 'paid') {
          isPaid = true;
        }
        MonitoringService.recordPaymentGateway('stripe', 'verify', 'success');
      }

      if (isPaid) {
        const updatedPayment = await this.completePayment(reference);
        return { status: 'completed', payment: updatedPayment };
      } else {
        return { status: externalStatus, payment };
      }
    } catch (error: any) {
      MonitoringService.recordPaymentGateway(payment.method || 'unknown', 'verify', 'failure');
      logger.error(`Verification failed for ${reference}: ${error.message}`);
      throw new AppError('Failed to verify payment with provider', 502);
    } finally {
      MonitoringService.observePaymentGatewayDuration(
        payment.method || 'unknown',
        'verify',
        (Date.now() - start) / 1000,
      );
    }
  }

  /**
   * Get payments for a specific user
   */
  static async getUserPayments(userId: string, type?: string) {
    const filter: any = { userId };
    if (type) filter.type = type;
    return Payment.find(filter).sort({ createdAt: -1 });
  }

  /**
   * Cancel active subscription
   */
  /**
   * Pay Premium subscription using Kauri Wallet balance
   */
  static async paySubscriptionWithWallet(userId: any, plan: 'premium' | 'business' = 'premium') {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    const priceInfo = await this.resolvePlanPrice(plan, user.country);
    const amount = priceInfo.amount;
    const currency = priceInfo.currency;

    // The wallet is denominated in the user's own currency, while the plan is
    // priced in their country's billing currency — compare/debit in wallet currency.
    const walletCurrency = (user.currency || currency).toUpperCase();
    const walletAmount = CurrencyService.convert(amount, currency, walletCurrency);

    if (user.walletBalance < walletAmount) {
      throw new AppError(
        `Solde insuffisant dans votre portefeuille (${user.walletBalance.toLocaleString()} ${walletCurrency} disponible, ${walletAmount.toLocaleString()} ${walletCurrency} requis).`,
        400,
      );
    }

    const reference = `WAL-${uuidv4().split('-')[0].toUpperCase()}`;

    const result = await WalletService.runInTransaction(async (session) => {
      const walletTransaction = await WalletService.executeTransaction(
        {
          userId: userIdStr,
          amount: walletAmount,
          type: 'withdrawal',
          description: `Abonnement Kauri ${plan === 'business' ? 'Super Premium (Business)' : 'Premium'} (Portefeuille)`,
          paymentMethod: 'wallet',
          reference,
        },
        { session },
      );

      const payment = await Payment.create(
        [
          {
            userId: userIdStr,
            amount,
            currency,
            method: 'wallet',
            type: 'subscription',
            reference,
            status: 'completed',
            completedAt: new Date(),
            metadata: { plan, walletAmount, walletCurrency },
          },
        ],
        { session },
      );

      const current = await User.findById(userIdStr).session(session);
      const now = new Date();
      const updatedUser = await User.findByIdAndUpdate(
        userIdStr,
        {
          'subscription.plan': plan,
          'subscription.status': 'active',
          'subscription.startDate':
            current?.subscription?.plan === plan && isSubscriptionEntitled(current.subscription)
              ? current.subscription?.startDate || now
              : now,
          'subscription.endDate': computeNewEndDate(current?.subscription, plan),
          'subscription.autoRenew': false,
        },
        { new: true, session },
      );

      return { payment: payment[0], walletTransaction, user: updatedUser };
    });

    InvoiceService.generateForPayment(result.payment._id.toString()).catch((err: any) =>
      logger.error(`Error generating invoice for wallet subscription: ${err.message}`),
    );

    // Awaited (F21) — this is a real wallet debit, same reasoning as COMPLETE_PAYMENT above.
    await AuditService.recordSync({
      userId,
      action: 'SUBSCRIBE_WALLET',
      resource: 'PAYMENT',
      resourceId: reference,
      status: 'success',
      metadata: { method: 'wallet', amount, type: 'subscription' },
    });

    NotificationService.sendToUser(userIdStr, {
      title: 'Abonnement Premium Activé 🌟',
      body: `Félicitations ! Votre abonnement Kauri ${plan === 'business' ? 'Super Premium (Business)' : 'Premium'} (1 mois) a été payé avec succès depuis votre portefeuille (${amount} ${currency}).`,
      category: 'transactional',
      data: { reference, type: 'subscription_success' },
    }).catch((err: any) => logger.error(`Notification Error: ${err.message}`));

    SlackService.sendFinance(
      `⭐ *Wallet Subscription Completed*\n*User ID*: ${userIdStr}\n*Amount*: ${amount} ${currency}\n*Reference*: ${reference}`,
    );

    return {
      reference,
      status: 'completed',
      message: `Abonnement Kauri ${plan === 'business' ? 'Super Premium (Business)' : 'Premium'} activé avec succès !`,
      user: result.user,
    };
  }

  static async cancelSubscription(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    const plan = user.subscription?.plan;
    if (
      (plan !== 'premium' && plan !== 'business') ||
      user.subscription?.status !== 'active' ||
      !isSubscriptionEntitled(user.subscription)
    ) {
      throw new AppError('No active premium subscription to cancel', 400);
    }

    // Access is kept until endDate (see utils/subscription.ts); the expiration
    // cron then moves the plan to 'expired'.
    user.subscription.status = 'cancelled';
    user.subscription.autoRenew = false;
    await user.save();

    MonitoringService.recordChurn(plan, 'manual_cancel');

    // Notify Slack (user ID is enough to look the account up; no need for email/PII here)
    SlackService.sendFinance(
      `📉 *Subscription Cancelled*\n*User ID*: ${userId}\n*Plan*: ${user.subscription.plan}`,
    );

    // Audit Log for subscription cancellation
    AuditService.record({
      userId: userId as any,
      action: 'CANCEL_SUBSCRIPTION',
      resource: 'USER',
      resourceId: userId,
      status: 'success',
    });

    return user;
  }
}
