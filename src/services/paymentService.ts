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

export class PaymentService {
  /**
   * List of currencies without decimals (e.g., XAF, JPY)
   */
  private static readonly ZERO_DECIMAL_CURRENCIES = [
    'XAF',
    'JPY',
    'CLP',
    'GNF',
    'KRW',
    'PYG',
    'VND',
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
  private static getSubscriptionPrice(countryCode?: string | null): { amount: number; currency: string } {
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
   * Create a Stripe Checkout Session for subscription or deposit
   */
  static async createStripeSession(
    userId: any,
    clientAmount: number,
    type: 'deposit' | 'subscription',
  ) {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    const reference = `STP-${uuidv4().split('-')[0].toUpperCase()}`;

    // For subscriptions, the price is a fixed, server-determined amount based on the
    // user's country — never trust a client-supplied amount for this. For deposits,
    // the user genuinely chooses how much to add to their own wallet, so the
    // client-supplied amount is what's actually charged and credited, which is safe.
    const { amount, currency } =
      type === 'subscription'
        ? this.getSubscriptionPrice(user.country)
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
                name: type === 'subscription' ? 'Kauri Premium' : 'Wallet Deposit',
              },
              unit_amount: this.formatAmount(amount, currency),
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
        cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
        customer_email: user.email,
        client_reference_id: userIdStr,
        metadata: {
          userId: userIdStr,
          type,
          reference,
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
  ) {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    // Geo-fencing: NotchPay only for Cameroon
    if (user.country !== 'CM') {
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

    // Basic format check for NotchPay (must be valid number, ideally starting with +)
    if (!/^\+?[1-9]\d{1,14}$/.test(finalPhone.replaceAll(' ', ''))) {
      throw new AppError('The phone number provided is not valid for NotchPay (+237...).', 400);
    }

    const reference = `NTP-${uuidv4().split('-')[0].toUpperCase()}`;

    // Same rule as Stripe: subscription price is fixed server-side, never client-supplied.
    const { amount, currency } =
      type === 'subscription'
        ? this.getSubscriptionPrice(user.country)
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
        description: type === 'subscription' ? 'Abonnement Kauri Premium' : 'Recharge Portefeuille',
        reference,
        callback: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
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
        logger.info(`Upgrading user ${payment.userId} to Premium...`);

        await User.findByIdAndUpdate(
          payment.userId,
          {
            'subscription.plan': 'premium',
            'subscription.status': 'active',
            'subscription.startDate': new Date(),
            'subscription.endDate': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
      (walletTransaction as any)._postCommit?.().catch((err: any) =>
        logger.error(`Post-commit hook error: ${err.message}`),
      );
      await InvoiceService.generateForTransaction(walletTransaction._id.toString());
    } else if (payment.type === 'subscription') {
      await InvoiceService.generateForPayment(payment._id.toString());
    }

    // Audit Log for payment completion
    AuditService.record({
      userId: payment.userId as any,
      action: 'COMPLETE_PAYMENT',
      resource: 'PAYMENT',
      resourceId: reference,
      status: 'success',
      metadata: { type: payment.type, amount: payment.amount },
    });

    // Notify Slack
    SlackService.sendNotification(
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
        externalStatus = session.payment_status;

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
  static async cancelSubscription(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError('User not found', 404);

    if (user.subscription?.plan !== 'premium' || user.subscription?.status !== 'active') {
      throw new AppError('No active premium subscription to cancel', 400);
    }

    user.subscription.status = 'cancelled';
    user.subscription.autoRenew = false;
    await user.save();

    MonitoringService.recordChurn(user.subscription.plan, 'manual_cancel');

    // Notify Slack (user ID is enough to look the account up; no need for email/PII here)
    SlackService.sendNotification(
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
