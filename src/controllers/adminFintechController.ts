import { Request, Response } from 'express';
import { KYCService } from '../services/kycService';
import { ReconciliationService } from '../services/reconciliationService';
import { ReportService } from '../services/reportService';
import User from '../models/User';
import { catchAsync } from '../utils';
import { AppError } from '../middleware/errorHandler';

export class AdminFintechController {
    /**
     * Liste des utilisateurs en attente de validation KYC
     */
    static getPendingKYC = catchAsync(async (req: any, res: Response) => {
        const users = await User.find({ kycLevel: 'pending' })
            .select('firstName lastName email kycData kycLevel');

        res.status(200).json({
            status: 'success',
            results: users.length,
            data: { users }
        });
    });

    /**
     * Valider ou rejeter manuellement un KYC
     */
    static verifyKYC = catchAsync(async (req: any, res: Response) => {
        const { userId, status, reason } = req.body; // status: 'verified' | 'none'

        if (!['verified', 'none'].includes(status)) {
            throw new AppError('Status invalide. Utilisez "verified" ou "none".', 400);
        }

        const user = await KYCService.adminVerify(userId, status, reason);

        res.status(200).json({
            status: 'success',
            message: `KYC ${status === 'verified' ? 'approuvé' : 'rejeté'}`,
            data: {
                kycLevel: user.kycLevel,
                rejectionReason: user.kycData?.rejectionReason
            }
        });
    });

    /**
     * Déclencher manuellement un audit d'intégrité interne (Réconciliation)
     */
    static triggerReconciliation = catchAsync(async (req: any, res: Response) => {
        const stats = await ReconciliationService.checkInternalIntegrity();

        res.status(200).json({
            status: 'success',
            data: stats
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
                    riskLevel: stats.health.riskLevel
                },
                period: stats.period,
                growth: stats.growth
            }
        });
    });
}
