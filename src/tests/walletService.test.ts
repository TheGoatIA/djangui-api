import { WalletService } from '../services/walletService';
import User from '../models/User';
import Transaction from '../models/Transaction';
import mongoose from 'mongoose';
import { NotificationService } from '../services/notificationService';
import { FinancialAlertService } from '../services/financialAlertService';

jest.mock('../models/User');
jest.mock('../models/Transaction');
jest.mock('../services/auditService');
jest.mock('../utils/logger');
jest.mock('../services/notificationService');
jest.mock('../services/financialAlertService');

describe('WalletService AML & Multi-Currency Tests', () => {
  let mockSession: any;

  beforeEach(() => {
    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
      withTransaction: jest.fn(async (fn: () => Promise<any>) => fn()),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession as any);
    (NotificationService.sendToUser as jest.Mock).mockResolvedValue(true);
    (FinancialAlertService.monitorTransaction as jest.Mock).mockResolvedValue(true);

    // Mock Transaction.aggregate par défaut pour le cumul journalier AML
    (Transaction.aggregate as jest.Mock).mockReturnValue({
      session: jest.fn().mockResolvedValue([{ total: 0 }]),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Deposit & Basic Balance', () => {
    it('should correctly credit wallet on deposit', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439011',
        walletBalance: 1000,
        currency: 'XAF',
        save: jest.fn().mockResolvedValue(true),
      };

      (User.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(mockUser),
      });

      (Transaction.create as jest.Mock).mockResolvedValue([{ _id: 'tx123', reference: 'REF123' }]);

      const result = await WalletService.executeTransaction({
        userId: '507f1f77bcf86cd799439011',
        amount: 500,
        type: 'deposit',
        description: 'Dépôt Test',
        paymentMethod: 'wallet',
      });

      expect(mockUser.walletBalance).toBe(1500);
      expect(result.reference).toBe('REF123');
    });
  });

  describe('AML Limits Checks (Multi-Currency)', () => {
    it('should reject a transaction exceeding single transaction limit for free user in XAF', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439012',
        currency: 'XAF',
        walletBalance: 200_000,
        subscription: { plan: 'free' },
        save: jest.fn().mockResolvedValue(true),
      };

      (User.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(mockUser),
      });

      // Free user limit is 50 000 XAF per single transaction
      await expect(
        WalletService.executeTransaction({
          userId: '507f1f77bcf86cd799439012',
          amount: 60_000,
          type: 'withdrawal',
          description: 'Retrait trop élevé',
          paymentMethod: 'wallet',
        }),
      ).rejects.toThrow('dépasse la limite par transaction');
    });

    it('should convert AML limit for EUR users (~76 EUR for 50 000 XAF)', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439013',
        currency: 'EUR',
        walletBalance: 500,
        subscription: { plan: 'free' },
        save: jest.fn().mockResolvedValue(true),
      };

      (User.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(mockUser),
      });

      // 50 000 XAF / 655.957 ≈ 76.22 EUR
      // Trying 100 EUR should be rejected by AML check
      await expect(
        WalletService.executeTransaction({
          userId: '507f1f77bcf86cd799439013',
          amount: 100,
          type: 'withdrawal',
          description: 'Withdrawal in EUR exceeding AML',
          paymentMethod: 'wallet',
        }),
      ).rejects.toThrow('dépasse la limite par transaction');
    });

    it('should reject withdrawal when wallet balance is insufficient', async () => {
      const mockUser = {
        _id: '507f1f77bcf86cd799439014',
        currency: 'XAF',
        walletBalance: 5000,
        subscription: { plan: 'free' },
        save: jest.fn().mockResolvedValue(true),
      };

      (User.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(mockUser),
      });

      await expect(
        WalletService.executeTransaction({
          userId: '507f1f77bcf86cd799439014',
          amount: 10_000,
          type: 'withdrawal',
          description: 'Withdrawal exceeding balance',
          paymentMethod: 'wallet',
        }),
      ).rejects.toThrow('Solde insuffisant dans le portefeuille');
    });
  });
});
