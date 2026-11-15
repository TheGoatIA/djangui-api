import { Request, Response, NextFunction } from 'express';
import { GoalService } from '../services/goalService';
import { AuthRequest } from '../middleware/auth';

export class GoalController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const goal = await GoalService.createGoal(req.user._id, req.body);
      res.status(201).json({
        success: true,
        data: goal,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const filters = {
        status: req.query.status,
        type: req.query.type,
      };
      const goals = await GoalService.getGoals(req.user._id, filters);
      res.status(200).json({
        success: true,
        data: goals,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getOne(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const goal = await GoalService.getGoalById(req.params.id, req.user._id);
      res.status(200).json({
        success: true,
        data: goal,
      });
    } catch (err) {
      next(err);
    }
  }

  static async addContribution(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, note } = req.body;
      const goal = await GoalService.addContribution(req.params.id, req.user._id, amount, note);
      res.status(200).json({
        success: true,
        data: goal,
      });
    } catch (err) {
      next(err);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const goal = await GoalService.updateGoal(req.params.id, req.user._id, req.body);
      res.status(200).json({
        success: true,
        data: goal,
      });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await GoalService.deleteGoal(req.params.id, req.user._id);
      res.status(200).json({
        success: true,
        message: 'Goal deleted successfully',
      });
    } catch (err) {
      next(err);
    }
  }

  static async redeem(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount } = req.body;
      const goal = await GoalService.redeemGoal(req.params.id, req.user._id, amount);
      res.status(200).json({
        success: true,
        data: goal,
      });
    } catch (err) {
      next(err);
    }
  }

  static async share(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await GoalService.shareGoal(req.params.id, req.user._id);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  static async join(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { inviteCode } = req.body;
      const displayName = `${req.user.firstName} ${req.user.lastName}`.trim();
      const goal = await GoalService.joinGoal(req.user._id, displayName, inviteCode);
      res.status(200).json({ success: true, data: goal });
    } catch (err) {
      next(err);
    }
  }

  static async getParticipants(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const participants = await GoalService.getParticipants(req.params.id, req.user._id);
      res.status(200).json({ success: true, data: participants });
    } catch (err) {
      next(err);
    }
  }

  static async removeParticipant(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await GoalService.removeParticipant(req.params.id, req.user._id, req.params.participantId);
      res.status(204).json({ success: true, data: null });
    } catch (err) {
      next(err);
    }
  }

  static async leave(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await GoalService.leaveGoal(req.params.id, req.user._id);
      res.status(200).json({ success: true, message: 'Left goal successfully' });
    } catch (err) {
      next(err);
    }
  }
}
