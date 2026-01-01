import { Response, NextFunction } from 'express';
import { InsightService } from '../services/ai/insightService';
import { AuthRequest } from '../middleware/auth';

export class InsightController {
    static async getAnalysis(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const analysis = await InsightService.getSpendingAnalysis(req.user._id);
            res.status(200).json({
                success: true,
                data: analysis,
            });
        } catch (err) {
            next(err);
        }
    }
}
