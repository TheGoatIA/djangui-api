import { Response, NextFunction } from 'express';
import { ForecastService } from '../services/ai/forecastService';
import { AuthRequest } from '../middleware/auth';

export class ForecastController {
    /**
     * Get 30-day cashflow forecast
     */
    static async getBalanceForecast(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const forecast = await ForecastService.getBalanceForecast(req.user._id);

            res.status(200).json({
                success: true,
                data: forecast,
            });
        } catch (err) {
            next(err);
        }
    }
}
