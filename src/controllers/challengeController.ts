import { Response, NextFunction } from 'express';
import { ChallengeService } from '../services/challengeService';
import { AuthRequest } from '../middleware/auth';

export class ChallengeController {
  static async getAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const challenges = await ChallengeService.getAllChallenges();
      res.status(200).json({
        success: true,
        data: challenges,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getUserChallenges(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userChallenges = await ChallengeService.getUserChallenges(req.user._id);
      res.status(200).json({
        success: true,
        data: userChallenges,
      });
    } catch (err) {
      next(err);
    }
  }

  static async join(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { challengeId } = req.body;
      const userChallenge = await ChallengeService.joinChallenge(req.user._id, challengeId);
      res.status(201).json({
        success: true,
        data: userChallenge,
      });
    } catch (err) {
      next(err);
    }
  }

  static async depositMoney(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userChallengeId, weekNumber, amount } = req.body;

      const userChallenge = await ChallengeService.addChallengeDeposit(
        req.user._id,
        userChallengeId,
        Number(weekNumber),
        Number(amount),
      );
      res.status(200).json({
        success: true,
        data: userChallenge,
      });
    } catch (err) {
      next(err);
    }
  }
  static async unjoin(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      await ChallengeService.unjoinChallenge(id, req.user._id);
      res.status(204).json({
        success: true,
        data: null,
      });
    } catch (err) {
      next(err);
    }
  }
}
