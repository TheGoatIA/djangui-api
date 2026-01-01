import stripe from '../config/stripe';
import { notchpayApi } from '../config/notchpay';
import Payment from '../models/Payment';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';

export class PaymentService {
    /**
     * Create a Stripe Checkout Session for subscription or deposit
     */
    static async createStripeSession(userId: string, amount: number, type: 'deposit' | 'subscription') {
        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        const reference = `STP-${uuidv4().split('-')[0].toUpperCase()}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'eur', // Or user preference
                        product_data: {
                            name: type === 'subscription' ? 'Djangui Premium' : 'Wallet Deposit',
                        },
                        unit_amount: amount * 100,
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
            customer_email: user.email,
            client_reference_id: userId,
            metadata: {
                userId,
                type,
                reference,
            },
        });

        await Payment.create({
            userId,
            amount,
            currency: 'EUR',
            method: 'stripe',
            type,
            reference,
            status: 'pending',
            externalReference: session.id,
        });

        return { url: session.url, reference };
    }

    /**
     * Initialize a NotchPay payment
     */
    static async initializeNotchPay(userId: string, amount: number, type: 'deposit' | 'subscription') {
        const user = await User.findById(userId);
        if (!user) throw new AppError('User not found', 404);

        const reference = `NTP-${uuidv4().split('-')[0].toUpperCase()}`;

        try {
            const response = await notchpayApi.post('/payments/initialize', {
                amount,
                currency: 'XAF',
                email: user.email,
                description: type === 'subscription' ? 'Abonnement Djangui Premium' : 'Recharge Portefeuille',
                reference,
                callback: `${process.env.FRONTEND_URL}/payment/success?ref=${reference}`,
            });

            await Payment.create({
                userId,
                amount,
                currency: 'XAF',
                method: 'notchpay',
                type,
                reference,
                status: 'pending',
                externalReference: response.data.payment.reference,
            });

            return {
                url: response.data.authorization_url,
                reference,
            };
        } catch (error: any) {
            logger.error(`NotchPay initialization error: ${error.response?.data?.message || error.message}`);
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
                $inc: { walletBalance: payment.amount }
            });
        } else if (payment.type === 'subscription') {
            await User.findByIdAndUpdate(payment.userId, {
                'subscription.plan': 'premium',
                'subscription.status': 'active',
                'subscription.startDate': new Date(),
                // Plan for 1 month
                'subscription.endDate': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            });
        }

        return payment;
    }
}
