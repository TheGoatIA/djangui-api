import { Response, NextFunction } from 'express';
import { ReportService, ReportPeriod } from '../services/reportService';
import { ExportService } from '../services/exportService';
import { AuthRequest } from '../middleware/auth';

const VALID_PERIODS: ReportPeriod[] = ['weekly', 'monthly', 'yearly'];

function parsePeriod(value: unknown): ReportPeriod | undefined {
  return VALID_PERIODS.includes(value as ReportPeriod) ? (value as ReportPeriod) : undefined;
}

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
      // Explicit month+year (calendar drill-down, e.g. from a date picker) takes
      // priority; otherwise `period` (weekly/monthly/yearly) picks the rolling
      // window — this is what the mobile app's period selector drives.
      const parsedMonth = parseInt(req.query.month as string);
      const parsedYear = parseInt(req.query.year as string);
      const hasExplicitMonth = !isNaN(parsedMonth) && !isNaN(parsedYear);
      const month = hasExplicitMonth ? parsedMonth : undefined;
      const year = hasExplicitMonth ? parsedYear : undefined;
      const period = parsePeriod(req.query.period);

      const analysis = await ReportService.getSpendingAnalysis(req.user._id, {
        month,
        year,
        period,
      });
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
      const period = parsePeriod(req.query.period) || 'monthly';
      const trends = await ReportService.getSavingsTrend(req.user._id, period);
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

  static async getHealthScoreHistory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const months = parseInt(req.query.months as string) || 6;
      const history = await ReportService.getHealthScoreHistory(req.user._id, months);
      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (err) {
      next(err);
    }
  }
}
