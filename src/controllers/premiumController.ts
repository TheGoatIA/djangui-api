import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { AutoBudgetService } from '../services/ai/autoBudgetService';
import { ReportService } from '../services/ai/reportService';
import UserActivity from '../models/UserActivity';

export class PremiumController {
  /**
   * Generates an AI-optimized budget
   */
  static async generateAutoBudget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const month = req.query.month ? parseInt(req.query.month as string) : undefined;
      const year = req.query.year ? parseInt(req.query.year as string) : undefined;

      const budget = await AutoBudgetService.generateBudget(req.user._id, month, year);

      // Track Activity
      await UserActivity.create({
        userId: req.user._id,
        feature: 'AI_Premium',
        action: 'generate_auto_budget',
        details: { month, year },
        platform: (req.headers['x-platform'] as any) || 'android',
      });

      res.status(200).json({
        success: true,
        data: budget,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Generates a monthly "Style Magazine" report
   */
  static async getMonthlyReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const report = await ReportService.getMonthlyReport(req.user._id, month, year);

      // Track Activity
      await UserActivity.create({
        userId: req.user._id,
        feature: 'AI_Premium',
        action: 'get_style_report',
        details: { month, year },
        platform: (req.headers['x-platform'] as any) || 'android',
      });

      res.status(200).json({
        success: true,
        data: report,
      });
    } catch (err) {
      next(err);
    }
  }
}
