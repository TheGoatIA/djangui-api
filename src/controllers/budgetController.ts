import { Request, Response, NextFunction } from 'express';
import { BudgetService } from '../services/budgetService';
import { AuthRequest } from '../middleware/auth';
import { MonitoringService } from '../services/monitoringService';

export class BudgetController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const budget = await BudgetService.createBudget(req.user._id, req.body);

      // Metrique business
      MonitoringService.recordBudgetCreation();

      res.status(201).json({
        success: true,
        data: budget,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getCurrent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const budget = await BudgetService.getCurrentBudget(req.user._id);
      res.status(200).json({
        success: true,
        data: budget,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const filters = {
        year: req.query.year,
        month: req.query.month,
      };
      const budgets = await BudgetService.getBudgets(req.user._id, filters);
      res.status(200).json({
        success: true,
        data: budgets,
      });
    } catch (err) {
      next(err);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const budget = await BudgetService.updateBudget(req.params.id, req.user._id, req.body);
      res.status(200).json({
        success: true,
        data: budget,
      });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await BudgetService.deleteBudget(req.params.id, req.user._id);
      res.status(204).json({
        success: true,
        data: null,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getCategoryHistory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const category = req.query.category as string;
      if (!category) {
        return res.status(400).json({ success: false, message: 'category est requis' });
      }
      const months = Math.min(24, Math.max(1, parseInt(req.query.months as string, 10) || 6));

      const history = await BudgetService.getCategoryHistory(req.user._id, category, months);
      res.status(200).json({ success: true, data: history });
    } catch (err) {
      next(err);
    }
  }

  static async share(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await BudgetService.shareBudget(req.params.id, req.user._id);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  static async join(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { inviteCode } = req.body;
      const displayName = `${req.user.firstName} ${req.user.lastName}`.trim();
      const budget = await BudgetService.joinBudget(req.user._id, displayName, inviteCode);
      res.status(200).json({ success: true, data: budget });
    } catch (err) {
      next(err);
    }
  }

  static async getParticipants(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const participants = await BudgetService.getParticipants(req.params.id, req.user._id);
      res.status(200).json({ success: true, data: participants });
    } catch (err) {
      next(err);
    }
  }

  static async removeParticipant(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await BudgetService.removeParticipant(req.params.id, req.user._id, req.params.participantId);
      res.status(204).json({ success: true, data: null });
    } catch (err) {
      next(err);
    }
  }

  static async leave(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await BudgetService.leaveBudget(req.params.id, req.user._id);
      res.status(204).json({ success: true, data: null });
    } catch (err) {
      next(err);
    }
  }
}
