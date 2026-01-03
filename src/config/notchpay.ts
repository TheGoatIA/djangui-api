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

export const notchpayApi = axios.create({
  baseURL: notchpayConfig.endpoint,
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
  headers: {
    Authorization: notchpayConfig.publicKey || '',
    'X-Grant': notchpayConfig.privateKey || '',
    Accept: 'application/json',
  },
});
