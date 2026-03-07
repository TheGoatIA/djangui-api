import { WalletService } from '../services/walletService';
import User from '../models/User';
import Transaction from '../models/Transaction';
import mongoose from 'mongoose';

// Mock minimaliste
jest.mock('../models/User');
jest.mock('../models/Transaction');
jest.mock('../services/auditService');
jest.mock('../services/notificationService');
jest.mock('../utils/logger');

describe('WalletService Simple Test', () => {
  let mockSession: any;

  beforeEach(() => {
    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn(),
    };
    // Mock global mongoose.startSession
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be able to execute a simple deposit', async () => {
    const mockUser = {
      _id: 'user123',
      walletBalance: 1000,
      currency: 'XAF',
      save: jest.fn().mockResolvedValue(true),
    };

    (User.findById as jest.Mock).mockReturnValue({
      session: jest.fn().mockResolvedValue(mockUser),
    });

    (Transaction.create as jest.Mock).mockResolvedValue([{ _id: 'tx123', reference: 'REF123' }]);

    const result = await WalletService.executeTransaction({
      userId: 'user123',
      amount: 500,
      type: 'deposit',
      description: 'Test',
      paymentMethod: 'wallet',
    });

    expect(mockUser.walletBalance).toBe(1500);
    expect(result.reference).toBe('REF123');
  });
});
