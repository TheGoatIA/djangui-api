import Stripe from 'stripe';
import logger from '../utils/logger';

const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const stripe = new Stripe(stripeKey, {
  apiVersion: '2025-01-27.acacia' as any,
});

if (!process.env.STRIPE_SECRET_KEY) {
  logger.warn(
    'STRIPE_SECRET_KEY is missing. Stripe payments will NOT work. Using placeholder key to prevent crash.',
  );
}

export default stripe;
