import axios from 'axios';
import logger from '../utils/logger';

export const notchpayConfig = {
  publicKey: process.env.NOTCHPAY_PUBLIC_KEY,
  privateKey: process.env.NOTCHPAY_PRIVATE_KEY,
  webhookSecret: process.env.NOTCHPAY_WEBHOOK_SECRET,
  endpoint: 'https://api.notchpay.co',
};

if (!notchpayConfig.privateKey) {
  logger.warn('NOTCHPAY_PRIVATE_KEY is missing. NotchPay payments will fail.');
}

// Axios has no timeout by default — a slow/hung NotchPay response would otherwise
// block indefinitely. This matters most for notchpayAdminApi's transfer calls
// (PayoutService.initiatePayout), which run AFTER the wallet has already been
// debited, so a hang here delays how quickly a stuck payout can be investigated.
const NOTCHPAY_TIMEOUT_MS = 15000;

export const notchpayApi = axios.create({
  baseURL: notchpayConfig.endpoint,
  timeout: NOTCHPAY_TIMEOUT_MS,
  headers: {
    Authorization: notchpayConfig.publicKey || '',
    Accept: 'application/json',
  },
});

/**
 * For sensitive operations requiring X-Grant
 */
export const notchpayAdminApi = axios.create({
  baseURL: notchpayConfig.endpoint,
  timeout: NOTCHPAY_TIMEOUT_MS,
  headers: {
    Authorization: notchpayConfig.publicKey || '',
    'X-Grant': notchpayConfig.privateKey || '',
    Accept: 'application/json',
  },
});
