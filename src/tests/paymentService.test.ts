import { PaymentService } from '../services/paymentService';
import User from '../models/User';
import Payment from '../models/Payment';
import stripe from '../config/stripe';
import { notchpayApi } from '../config/notchpay';

jest.mock('../models/User');
jest.mock('../models/Payment');
jest.mock('../config/stripe', () => ({
  checkout: {
    sessions: {
      create: jest.fn(),
    },
  },
  webhooks: {
    constructEvent: jest.fn(),
  },
}));
jest.mock('../config/notchpay', () => ({
  notchpayApi: {
    post: jest.fn(),
  },
  notchpayConfig: {
    endpoint: 'https://api.notchpay.co',
    publicKey: 'pk_test',
  },
}));
jest.mock('../services/auditService');
jest.mock('../services/slackService');
jest.mock('../services/monitoringService');
jest.mock('../services/walletService');
jest.mock('../services/invoiceService');
jest.mock('../utils/logger');
// createStripeSession/initializeNotchPay now gate on the real-money kill switch
// before doing anything else; without this mock the unmocked call hits a real
// Mongoose query with no DB connection in this unit test env and hangs until
// the test times out. Default to enabled so the pre-existing tests below keep
// exercising the validation logic they were written for.
jest.mock('../services/featureFlagService', () => ({
  FeatureFlagService: {
    isRealMoneyEnabled: jest.fn().mockResolvedValue(true),
    isCountryAllowedForRealMoney: jest
      .fn()
      .mockImplementation((countryCode?: string | null) => Promise.resolve(countryCode === 'CM')),
  },
}));

describe('PaymentService Unit Tests', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Zero-Decimal & Multi-Currency Formatting', () => {
    it('should format zero-decimal currencies without multiplying by 100', () => {
      const formatAmount = (PaymentService as any).formatAmount.bind(PaymentService);

      // XAF / XOF (Franc CFA)
      expect(formatAmount(5000, 'XAF')).toBe(5000);
      expect(formatAmount(10000, 'XOF')).toBe(10000);

      // JPY, BIF, GNF, RWF, UGX, KMF
      expect(formatAmount(1500, 'JPY')).toBe(1500);
      expect(formatAmount(25000, 'RWF')).toBe(25000);
      expect(formatAmount(50000, 'GNF')).toBe(50000);
    });

    it('should format decimal currencies with multiplying by 100 for Stripe cents', () => {
      const formatAmount = (PaymentService as any).formatAmount.bind(PaymentService);

      // EUR, USD, CAD (Standard decimal currencies)
      expect(formatAmount(10.5, 'EUR')).toBe(1050);
      expect(formatAmount(5.0, 'USD')).toBe(500);
      expect(formatAmount(15.99, 'CAD')).toBe(1599);
    });
  });

  describe('Subscription Pricing by Country', () => {
    it('should return 5 EUR for European countries', () => {
      const getPrice = (PaymentService as any).getSubscriptionPrice.bind(PaymentService);

      expect(getPrice('FR')).toEqual({ amount: 5.0, currency: 'EUR' });
      expect(getPrice('DE')).toEqual({ amount: 5.0, currency: 'EUR' });
      expect(getPrice('BE')).toEqual({ amount: 5.0, currency: 'EUR' });
    });

    it('should return 2000 XAF for Cameroon and default African zone', () => {
      const getPrice = (PaymentService as any).getSubscriptionPrice.bind(PaymentService);

      expect(getPrice('CM')).toEqual({ amount: 2000, currency: 'XAF' });
      expect(getPrice('SN')).toEqual({ amount: 2000, currency: 'XAF' });
      expect(getPrice('CI')).toEqual({ amount: 2000, currency: 'XAF' });
    });
  });

  describe('NotchPay Phone Validation', () => {
    it('should reject invalid phone numbers for NotchPay', async () => {
      const mockUser = {
        _id: 'user123',
        country: 'CM',
        phone: 'invalid-phone',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      };

      (User.findById as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        PaymentService.initializeNotchPay('user123', 5000, 'deposit', 'abc'),
      ).rejects.toThrow('Numéro de téléphone invalide');
    });

    it('should reject non-Cameroon users for NotchPay', async () => {
      const mockUser = {
        _id: 'user123',
        country: 'FR',
        phone: '+33612345678',
      };

      (User.findById as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        PaymentService.initializeNotchPay('user123', 5000, 'deposit'),
      ).rejects.toThrow('NotchPay is only available for users in Cameroon');
    });
  });
});
