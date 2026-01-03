import { Response, NextFunction } from 'express';
import { ReportService } from '../services/reportService';
import { ExportService } from '../services/exportService';
import { AuthRequest } from '../middleware/auth';

export class ReportController {
  static async getDashboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const summary = await ReportService.getDashboardSummary(req.user._id);
      res.status(200).json({
        success: true,
        data: summary,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAnalysis(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const analysis = await ReportService.getSpendingAnalysis(req.user._id, month, year);
      res.status(200).json({
        success: true,
        data: analysis,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getTrends(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const trends = await ReportService.getSavingsTrend(req.user._id);
      res.status(200).json({
        success: true,
        data: trends,
      });
    } catch (err) {
      next(err);
    }
  }

  static async exportCSV(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const csv = await ExportService.exportTransactionsToCSV(req.user._id, {
        startDate: startDate as string,
        endDate: endDate as string,
      });

      if (!csv) {
        return res
          .status(404)
          .json({ success: false, message: 'No transactions found for export' });
      }

      res.header('Content-Type', 'text/csv');
      res.attachment(`transactions-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  }

  static async getNarrativeReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const report = await ReportService.getNarrativeReport(req.user._id, month, year);
      res.status(200).json({
        success: true,
        data: report,
      });
    } catch (err) {
      next(err);
    }
  }
}
