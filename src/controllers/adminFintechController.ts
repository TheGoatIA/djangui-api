import { Request, Response } from 'express';
import { KYCService } from '../services/kycService';
import { ReconciliationService } from '../services/reconciliationService';
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
        const { userId, status, reason } = req.body;

        const user = await KYCService.adminVerify(userId, status, reason);

        res.status(200).json({
            status: 'success',
            message: `KYC ${status === 'verified' ? 'approuvé' : 'rejeté'}`,
            data: { kycLevel: user.kycLevel }
        });
    });

    /**
     * Déclencher manuellement une réconciliation bancaire
     */
    static triggerReconciliation = catchAsync(async (req: any, res: Response) => {
        const stats = await ReconciliationService.checkGlobalNotchPayBalance();

        res.status(200).json({
            status: 'success',
            data: stats
        });
    });

    /**
     * Obtenir des statistiques financières globales
     */
    static getFintechStats = catchAsync(async (req: any, res: Response) => {
        const stats = await User.aggregate([
            { $match: { isActive: true } },
            {
                $group: {
                    _id: '$country',
                    totalWallets: { $sum: 1 },
                    totalBalance: { $sum: '$walletBalance' }
                }
            }
        ]);

        res.status(200).json({
            status: 'success',
            data: { stats }
        });
    });
}
