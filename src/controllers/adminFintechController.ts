import { Response } from 'express';
import { ReconciliationService } from '../services/reconciliationService';
import { ReportService } from '../services/reportService';
import { catchAsync } from '../utils';

export class AdminFintechController {
  /**
   * Déclencher manuellement un audit d'intégrité interne (Réconciliation)
   */
  static triggerReconciliation = catchAsync(async (req: any, res: Response) => {
    const stats = await ReconciliationService.checkInternalIntegrity();

    res.status(200).json({
      status: 'success',
      data: stats,
    });
  });

  /**
   * Obtenir des statistiques financières globales (Argent Réel & AUM)
   */
  static getFintechStats = catchAsync(async (req: any, res: Response) => {
    const stats = await ReportService.getExecutiveFinancialReport('daily');

    res.status(200).json({
      status: 'success',
      data: {
        metrics: {
          totalAUM: stats.health.totalAUM,
          revenue: stats.revenue.totalFees,
          margin: stats.revenue.margin,
          volume24h: stats.transactions.totalVolume,
          anomalyCount: stats.health.anomalyCount,
          riskLevel: stats.health.riskLevel,
        },
        period: stats.period,
        growth: stats.growth,
      },
    });
  });
}
