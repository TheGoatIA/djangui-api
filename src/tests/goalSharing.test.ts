import { GoalService } from '../services/goalService';
import SavingGoal from '../models/SavingGoal';
import GoalParticipant from '../models/GoalParticipant';
import User from '../models/User';
import { WalletService } from '../services/walletService';
import { NotificationService } from '../services/notificationService';

jest.mock('../models/SavingGoal');
jest.mock('../models/GoalParticipant');
jest.mock('../models/User');
jest.mock('../services/walletService');
jest.mock('../services/notificationService');
jest.mock('../utils/logger');

describe('GoalService — collaborative goals', () => {
  const ownerId = 'owner1';
  const participantId = 'participant1';
  const strangerId = 'stranger1';
  const mockSession: any = {};

  beforeEach(() => {
    jest.clearAllMocks();
    (WalletService.runInTransaction as jest.Mock).mockImplementation((fn: any) => fn(mockSession));
    (WalletService.executeTransaction as jest.Mock).mockResolvedValue({});
    (NotificationService.sendToUser as jest.Mock).mockResolvedValue(true);
    (User.findById as jest.Mock).mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({ firstName: 'Ada', lastName: 'Lovelace' }),
      }),
    });
  });

  const makeGoal = (overrides: any = {}) => {
    const goal: any = {
      _id: 'goal1',
      userId: ownerId,
      name: 'Vacances',
      currency: 'XAF',
      currentAmount: 0,
      targetAmount: 1000,
      progress: 0,
      isShared: true,
      contributions: [],
      ...overrides,
    };
    goal.save = jest.fn().mockImplementation(async () => {
      goal.progress =
        goal.targetAmount > 0 ? Math.min(100, (goal.currentAmount / goal.targetAmount) * 100) : 0;
      return true;
    });
    return goal;
  };

  describe('addContribution — access control', () => {
    it('lets the owner contribute', async () => {
      const goal = makeGoal();
      (SavingGoal.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });

      await GoalService.addContribution('goal1', ownerId, 100);

      expect(WalletService.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ userId: ownerId, amount: 100 }),
        { session: mockSession },
      );
      expect(goal.currentAmount).toBe(100);
      expect(goal.contributions[0]).toMatchObject({ userId: ownerId, amount: 100 });
    });

    it('lets an accepted participant contribute, debiting THEIR OWN wallet', async () => {
      const goal = makeGoal();
      (SavingGoal.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (GoalParticipant.exists as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(true),
      });

      await GoalService.addContribution('goal1', participantId, 50);

      expect(GoalParticipant.exists).toHaveBeenCalledWith({
        goalId: 'goal1',
        userId: participantId,
        invitationStatus: 'accepted',
      });
      // The debit happens on the CONTRIBUTOR's wallet, not the owner's.
      expect(WalletService.executeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ userId: participantId, amount: 50 }),
        { session: mockSession },
      );
      // But the shared pot (currentAmount) grows regardless of who paid.
      expect(goal.currentAmount).toBe(50);
      expect(goal.contributions[0]).toMatchObject({ userId: participantId, amount: 50 });
    });

    it('rejects a stranger with 404 (not 403, to avoid confirming the goal exists)', async () => {
      const goal = makeGoal();
      (SavingGoal.findById as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(goal),
      });
      (GoalParticipant.exists as jest.Mock).mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(GoalService.addContribution('goal1', strangerId, 50)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(WalletService.executeTransaction).not.toHaveBeenCalled();
    });
  });

  describe('checkMilestones — notifies owner + participants', () => {
    it('notifies every accepted participant plus the owner, deduplicated', async () => {
      (GoalParticipant.find as jest.Mock).mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ userId: participantId }, { userId: 'participant2' }]),
        }),
      });
      const goal = makeGoal({ progress: 55 });

      await GoalService.checkMilestones(ownerId, goal, false, false, false, false);

      expect(NotificationService.sendToUser).toHaveBeenCalledTimes(3);
      const recipientIds = (NotificationService.sendToUser as jest.Mock).mock.calls.map(
        (call) => call[0],
      );
      expect(recipientIds.sort()).toEqual([ownerId, participantId, 'participant2'].sort());
    });
  });

  describe('joinGoal', () => {
    it('rejects the owner joining their own goal', async () => {
      const goal = makeGoal();
      (SavingGoal.findOne as jest.Mock).mockResolvedValue(goal);

      await expect(GoalService.joinGoal(ownerId, 'Ada', 'ABC123')).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('rejects an invalid invite code with 404', async () => {
      (SavingGoal.findOne as jest.Mock).mockResolvedValue(null);

      await expect(GoalService.joinGoal(participantId, 'Ada', 'BADCODE')).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('reactivates a previously-removed participant instead of erroring', async () => {
      const goal = makeGoal();
      (SavingGoal.findOne as jest.Mock).mockResolvedValue(goal);
      const existing: any = {
        invitationStatus: 'removed',
        joinedAt: new Date('2020-01-01'),
        save: jest.fn().mockResolvedValue(true),
      };
      (GoalParticipant.findOne as jest.Mock).mockResolvedValue(existing);

      await GoalService.joinGoal(participantId, 'Ada', 'ABC123');

      expect(existing.invitationStatus).toBe('accepted');
      expect(existing.save).toHaveBeenCalled();
      expect(GoalParticipant.create).not.toHaveBeenCalled();
    });

    it('creates a new participant on first join', async () => {
      const goal = makeGoal();
      (SavingGoal.findOne as jest.Mock).mockResolvedValue(goal);
      (GoalParticipant.findOne as jest.Mock).mockResolvedValue(null);

      await GoalService.joinGoal(participantId, 'Ada', 'ABC123');

      expect(GoalParticipant.create).toHaveBeenCalledWith(
        expect.objectContaining({
          goalId: 'goal1',
          userId: participantId,
          invitationStatus: 'accepted',
        }),
      );
    });
  });
});
