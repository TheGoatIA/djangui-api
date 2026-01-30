import stripe from '../config/stripe';
import { notchpayApi } from '../config/notchpay';
import Payment from '../models/Payment';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { NotificationService } from './notificationService';
import { AuditService } from './auditService';
import { SlackService } from './slackService';

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
   * Create a Stripe Checkout Session for subscription or deposit
   */
  static async createStripeSession(userId: any, amount: number, type: 'deposit' | 'subscription') {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    const reference = `STP-${uuidv4().split('-')[0].toUpperCase()}`;
    const currency = user.currency || 'USD';

    const session = await stripe.checkout.sessions.create({
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
      userId: userId as any,
      action: 'INIT_PAYMENT',
      resource: 'PAYMENT',
      resourceId: reference,
      status: 'success',
      metadata: { method: 'stripe', amount, type },
    });

    return { url: session.url, reference };
  }

  /**
   * Initialize a NotchPay payment (Restricted to Cameroon)
   */
  static async initializeNotchPay(userId: any, amount: number, type: 'deposit' | 'subscription') {
    const userIdStr = userId.toString();
    const user = await User.findById(userIdStr);
    if (!user) throw new AppError('User not found', 404);

    // Geo-fencing: NotchPay only for Cameroon
    if (user.country !== 'CM') {
      throw new AppError('NotchPay is only available for users in Cameroon.', 400);
    }

    const reference = `NTP-${uuidv4().split('-')[0].toUpperCase()}`;
    const currency = user.currency || 'XAF';

    try {
      const response = await notchpayApi.post('/payments', {
        amount: this.formatAmount(amount, currency),
        currency: currency,
        customer: {
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          phone: user.phone,
        },
        description: type === 'subscription' ? 'Abonnement Kauri Premium' : 'Recharge Portefeuille',
        reference,
        callback: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
      });

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
        userId: userId as any,
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
      logger.error(
        `NotchPay initialization error: ${error.response?.data?.message || error.message}`,
      );
      throw new AppError('Payment initialization failed', 500);
    }
  }

  /**
   * Complete payment (usually called via webhook)
   */
  static async completePayment(reference: string, externalRef?: string) {
    const payment = await Payment.findOne({ reference });
    if (!payment) throw new AppError('Payment not found', 404);
    if (payment.status === 'completed') return payment;

    payment.status = 'completed';
    payment.externalReference = externalRef || payment.externalReference;
    payment.completedAt = new Date();
    await payment.save();

    // If it's a deposit, update wallet,
    // If it's a subscription, update user plan
    if (payment.type === 'deposit') {
      await User.findByIdAndUpdate(payment.userId, {
        $inc: { walletBalance: payment.amount },
      });

      // Notify
      await NotificationService.sendToUser(payment.userId.toString(), {
        title: '',
        body: '',
        category: 'transactional',
        translationKey: 'RECHARGE_SUCCESS',
        translationData: { amount: payment.amount, currency: payment.currency },
        data: { type: 'payment', status: 'success', reference },
      });
    } else if (payment.type === 'subscription') {
      logger.info(`Upgrading user ${payment.userId} to Premium...`);
      const updatedUser = await User.findByIdAndUpdate(
        payment.userId,
        {
          'subscription.plan': 'premium',
          'subscription.status': 'active',
          'subscription.startDate': new Date(),
          // Plan for 1 month
          'subscription.endDate': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        { new: true },
      );

      logger.info(`User upgrade result: ${updatedUser?.subscription?.plan}`);

      // Notify
      await NotificationService.sendToUser(payment.userId.toString(), {
        title: '',
        body: '',
        category: 'transactional',
        translationKey: 'SUBSCRIPTION_ACTIVATED',
        data: { type: 'payment', status: 'success', reference },
      });
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
   * Manually verify transaction status with provider
   */
  static async verifyTransaction(reference: string) {
    const payment = await Payment.findOne({ reference });
    if (!payment) throw new AppError('Payment not found', 404);

    if (payment.status === 'completed') {
      return { status: 'completed', payment };
    }

    let isPaid = false;
    let externalStatus = 'pending';

    try {
      if (payment.method === 'notchpay') {
        // Verify with NotchPay API
        const response = await notchpayApi.get(`/payments/${payment.externalReference}`);
        const transaction = response.data.transaction;
        externalStatus = transaction.status;

        if (transaction.status === 'complete' || transaction.status === 'completed') {
          isPaid = true;
        }
      } else if (payment.method === 'stripe') {
        // Verify with Stripe API
        const session = await stripe.checkout.sessions.retrieve(payment.externalReference!);
        externalStatus = session.payment_status;

        if (session.payment_status === 'paid') {
          isPaid = true;
        }
      }

      if (isPaid) {
        const updatedPayment = await this.completePayment(reference);
        return { status: 'completed', payment: updatedPayment };
      } else {
        return { status: externalStatus, payment };
      }
    } catch (error: any) {
      logger.error(`Verification failed for ${reference}: ${error.message}`);
      throw new AppError('Failed to verify payment with provider', 502);
    }
  }

  /**
   * Get payments for a specific user
   */
  static async getUserPayments(userId: string) {
    return Payment.find({ userId }).sort({ createdAt: -1 });
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

    // Notify Slack
    SlackService.sendNotification(
      `📉 *Subscription Cancelled*\n*User ID*: ${userId}\n*Email*: ${user.email}\n*Plan*: ${user.subscription.plan}`,
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
