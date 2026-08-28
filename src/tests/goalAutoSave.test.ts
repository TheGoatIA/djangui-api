import { TransactionService } from '../services/transactionService';
import SavingGoal from '../models/SavingGoal';
import { WalletService } from '../services/walletService';
import { GoalService } from '../services/goalService';
import { NotificationService } from '../services/notificationService';

jest.mock('../models/SavingGoal');
jest.mock('../services/walletService');
jest.mock('../services/notificationService');
jest.mock('../utils/logger');

describe('TransactionService automated saving strategies (autoSaveRules)', () => {
  const userId = 'user1';
  const mockSession: any = {};

  beforeEach(() => {
    jest.clearAllMocks();
    (NotificationService.sendToUser as jest.Mock).mockResolvedValue(true);
  });

  // `save` mimics the real SavingGoal pre-save hook (recomputes `progress`
  // from currentAmount/targetAmount) since GoalService.checkMilestones reads
  // `goal.progress`, not a live division — without this, a mocked `.save()`
  // that doesn't touch `progress` would make every milestone check see it
  // stuck at `undefined` and never fire, which is a test-mock gap, not a
  // production bug (a real Mongoose `.save()` always runs the hook first).
  const makeGoal = (overrides: any = {}) => {
    const goal: any = {
      _id: 'goal1',
      userId,
      name: 'Vacances',
      type: 'regular',
      currency: 'XAF',
      currentAmount: 0,
      targetAmount: 1000,
      progress: 0,
      contributions: [],
      autoSaveRules: {},
      ...overrides,
    };
    goal.save = jest.fn().mockImplementation(async () => {
      goal.progress =
        goal.targetAmount > 0 ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100) : 0;
      return true;
    });
    return goal;
  };

  describe('Roundup strategy', () => {
    it('rounds an expense up to the next 100 and contributes the difference', async () => {
      const goal = makeGoal({ currentAmount: 100 });
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});

      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 750 },
        mockSession,
      );

      expect(WalletService.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          amount: 50, // 750 -> next 100 is 800, difference is 50
          type: 'saving_transfer',
          category: 'goal_auto_save',
        }),
        { session: mockSession },
      );
      expect(goal.currentAmount).toBe(150); // 100 + 50
      expect(goal.contributions).toHaveLength(1);
      expect(goal.save).toHaveBeenCalledWith({ session: mockSession });
    });

    it('rounds an expense above 1000 up to the next 1000', async () => {
      const goal = makeGoal();
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});

      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 4200 },
        mockSession,
      );

      expect(WalletService.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 800 }), // 4200 -> 5000
        { session: mockSession },
      );
    });

    it('does nothing when no active goal has roundup enabled', async () => {
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });

      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 750 },
        mockSession,
      );

      expect(WalletService.executeTransaction).not.toHaveBeenCalled();
    });

    it('does nothing when the expense is already a round number', async () => {
      const goal = makeGoal();
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });

      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 500 }, // exact multiple of 100
        mockSession,
      );

      expect(WalletService.executeTransaction).not.toHaveBeenCalled();
      expect(goal.save).not.toHaveBeenCalled();
    });

    it('never fails the parent transaction when the wallet balance is insufficient', async () => {
      const goal = makeGoal({ currentAmount: 100 });
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (WalletService.executeTransaction as jest.Mock).mockRejectedValue(
        new Error('Solde insuffisant dans le portefeuille'),
      );

      await expect(
        (TransactionService as any).applyRoundupStrategy(
          userId,
          { type: 'expense', amount: 750 },
          mockSession,
        ),
      ).resolves.toBeUndefined(); // must swallow the error, not throw

      expect(goal.currentAmount).toBe(100); // untouched
      expect(goal.save).not.toHaveBeenCalled();
    });
  });

  describe('Income percentage strategy', () => {
    it('contributes the configured percentage of income to every eligible goal', async () => {
      const goalA = makeGoal({
        _id: 'a',
        autoSaveRules: { percentageIncome: 10 },
      });
      const goalB = makeGoal({
        _id: 'b',
        autoSaveRules: { percentageIncome: 20 },
      });
      (SavingGoal.find as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue([goalA, goalB]),
      });
      (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});

      await (TransactionService as any).applyIncomePercentageStrategy(
        userId,
        { type: 'income', amount: 10000 },
        mockSession,
      );

      expect(goalA.currentAmount).toBe(1000); // 10% of 10000
      expect(goalB.currentAmount).toBe(2000); // 20% of 10000
      expect(WalletService.executeTransaction).toHaveBeenCalledTimes(2);
    });

    it('skips a goal whose automatic debit fails, without affecting the others', async () => {
      const goalA = makeGoal({
        _id: 'a',
        autoSaveRules: { percentageIncome: 10 },
      });
      const goalB = makeGoal({
        _id: 'b',
        autoSaveRules: { percentageIncome: 20 },
      });
      (SavingGoal.find as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue([goalA, goalB]),
      });
      (WalletService.executeTransaction as jest.Mock)
        .mockRejectedValueOnce(new Error('Solde insuffisant'))
        .mockResolvedValueOnce({});

      await (TransactionService as any).applyIncomePercentageStrategy(
        userId,
        { type: 'income', amount: 10000 },
        mockSession,
      );

      expect(goalA.currentAmount).toBe(0); // failed, untouched
      expect(goalB.currentAmount).toBe(2000); // still applied
    });
  });

  describe('Milestone notifications fire during automated contributions', () => {
    it('sends GOAL_MILESTONE_50 when a roundup crosses the 50% threshold', async () => {
      const goal = makeGoal({ currentAmount: 480, targetAmount: 1000 }); // 48%
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});

      // 750 -> roundup of 50, bringing currentAmount to 530 (53%)
      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 750 },
        mockSession,
      );

      expect(NotificationService.sendToUser).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ translationKey: 'GOAL_MILESTONE_50' }),
      );
    });

    it('does not re-fire a milestone already crossed before this contribution', async () => {
      const goal = makeGoal({ currentAmount: 600, targetAmount: 1000 }); // already past 50%
      (SavingGoal.findOne as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});

      await (TransactionService as any).applyRoundupStrategy(
        userId,
        { type: 'expense', amount: 750 }, // +50, still under 75%
        mockSession,
      );

      expect(NotificationService.sendToUser).not.toHaveBeenCalled();
    });
  });

  describe('GoalService.milestoneFlags', () => {
    it('flags exactly the thresholds already reached', () => {
      expect(GoalService.milestoneFlags(0, 100)).toEqual({
        was25: false,
        was50: false,
        was75: false,
        was100: false,
      });
      expect(GoalService.milestoneFlags(25, 100)).toEqual({
        was25: true,
        was50: false,
        was75: false,
        was100: false,
      });
      expect(GoalService.milestoneFlags(60, 100)).toEqual({
        was25: true,
        was50: true,
        was75: false,
        was100: false,
      });
      expect(GoalService.milestoneFlags(100, 100)).toEqual({
        was25: true,
        was50: true,
        was75: true,
        was100: true,
      });
    });
  });
});
