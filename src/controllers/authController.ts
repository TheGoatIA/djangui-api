import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';

export class AuthController {
    static async register(req: Request, res: Response, next: NextFunction) {
        try {
            const { user, tokens } = await AuthService.register(req.body);

            res.status(201).json({
                success: true,
                data: {
                    user,
                    tokens,
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async login(req: Request, res: Response, next: NextFunction) {
        try {
            const { email, password } = req.body;
            const { user, tokens } = await AuthService.login(email, password);

            res.status(200).json({
                success: true,
                data: {
                    user,
                    tokens,
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async refresh(req: Request, res: Response, next: NextFunction) {
        try {
            const { refreshToken } = req.body;
            const tokens = await AuthService.refreshAccessToken(refreshToken);

            res.status(200).json({
                success: true,
                data: {
                    tokens,
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async updateFCMToken(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { fcmToken } = req.body;
            if (!fcmToken) {
                return res.status(400).json({ success: false, message: 'FCM token is required' });
            }

            await AuthService.addFCMToken(req.user._id, fcmToken);

            res.status(200).json({
                success: true,
                message: 'FCM token updated successfully',
            });
        } catch (err) {
            next(err);
        }
    }

    static async logout(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            await AuthService.logout(req.user._id);

            res.status(200).json({
                success: true,
                message: 'Logged out successfully',
            });
        } catch (err) {
            next(err);
        }
    }
}
