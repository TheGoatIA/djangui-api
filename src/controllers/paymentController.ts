import { Response, NextFunction } from 'express';
import { PaymentService } from '../services/paymentService';
import { AuthRequest } from '../middleware/auth';

export class PaymentController {
    static async checkoutStripe(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { amount, type } = req.body;
            const result = await PaymentService.createStripeSession(req.user._id, amount, type);
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (err) {
            next(err);
        }
    }

    static async initNotchPay(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { amount, type } = req.body;
            const result = await PaymentService.initializeNotchPay(req.user._id, amount, type);
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (err) {
            next(err);
        }
    }
}
