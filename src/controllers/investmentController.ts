import { Request, Response, NextFunction } from 'express';
import { InvestmentService } from '../services/investmentService';
import { AuthRequest } from '../middleware/auth';

export class InvestmentController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const investment = await InvestmentService.createInvestment(req.user!._id, req.body);
      res.status(201).json({ success: true, data: investment });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const status = req.query.status as string;
      const investments = await InvestmentService.listInvestments(req.user!._id, status);
      res.status(200).json({ success: true, data: investments });
    } catch (error) {
      next(error);
    }
  }

  static async updateValue(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { value } = req.body;
      const investment = await InvestmentService.updateValue(req.user!._id, id, value);
      res.status(200).json({ success: true, data: investment });
    } catch (error) {
      next(error);
    }
  }

  static async close(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { value } = req.body;
      const investment = await InvestmentService.closeInvestment(req.user!._id, id, value);
      res.status(200).json({ success: true, data: investment });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      await InvestmentService.deleteInvestment(id, req.user!._id);
      res.status(204).json({ success: true, data: null });
    } catch (error) {
      next(error);
    }
  }
}
