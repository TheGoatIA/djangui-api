import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
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

  static async firebaseAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const { idToken } = req.body;
      if (!idToken) throw new AppError('Firebase ID token is required', 400);

      const result = await AuthService.firebaseAuth(idToken);
      res.status(200).json({
        status: 'success',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }

  static async linkPhoneNumber(req: Request, res: Response, next: NextFunction) {
    try {
      const { idToken } = req.body;
      if (!idToken) throw new AppError('Firebase ID token is required', 400);

      const user = await AuthService.linkPhoneNumber((req as any).user.id, idToken);
      res.status(200).json({
        status: 'success',
        user,
      });
    } catch (error) {
      next(error);
    }
  }

  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const { user, tokens } = await AuthService.login(email, password, {
        deviceId: req.body.deviceId,
        deviceInfo: req.body.deviceInfo,
        appVersion: req.body.appVersion,
        ipAddress: req.ip,
      });

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

  static async changePassword(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await AuthService.changePassword(req.user._id, req.body);
      res.status(200).json({
        success: true,
        message: 'Password updated successfully',
      });
    } catch (err) {
      next(err);
    }
  }

  static async deleteMe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await AuthService.deleteAccount(req.user._id);
      res.status(200).json({
        success: true,
        message: 'Account deleted successfully',
      });
    } catch (err) {
      next(err);
    }
  }

  static async getSessions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const sessions = await AuthService.getSessions(req.user._id);
      res.status(200).json({
        success: true,
        data: {
          sessions,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async revokeSession(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      await AuthService.revokeSession(req.user._id, sessionId);
      res.status(200).json({
        success: true,
        message: 'Session revoked successfully',
      });
    } catch (err) {
      next(err);
    }
  }

  static async revokeAllSessions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await AuthService.revokeAllSessions(req.user._id);
      res.status(200).json({
        success: true,
        message: 'All sessions revoked successfully',
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

  static async updateMe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await AuthService.updateMe(req.user._id, req.body);
      res.status(200).json({
        success: true,
        data: {
          user,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.status(200).json({
        success: true,
        data: {
          user: req.user,
        },
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

  static async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.body.email) {
        throw new AppError('Email is required', 400);
      }
      await AuthService.forgotPassword(req.body.email);

      res.status(200).json({
        success: true,
        message: 'Token sent to email!',
      });
    } catch (err) {
      next(err);
    }
  }

  static async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { password } = req.body;
      const { token } = req.params;
      const { user, tokens } = await AuthService.resetPassword(token, password);

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

  static async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { token } = req.query;
      if (!token || typeof token !== 'string') {
        throw new AppError('Token is invalid', 400);
      }
      const { user, tokens } = await AuthService.verifyEmail(token);

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

  static async updateDeviceInfo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { deviceInfo, appVersion } = req.body;
      const user = await AuthService.updateDeviceInfo(req.user._id, { deviceInfo, appVersion });

      res.status(200).json({
        success: true,
        data: {
          user,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  static async logConnection(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { ip, country, city, device } = req.body;
      const ConnectionLog = await import('../models/ConnectionLog').then(m => m.default);

      await ConnectionLog.create({
        userId: req.user._id,
        ip: ip || req.ip,
        country,
        city,
        device,
      });

      res.status(200).json({
        success: true,
        message: 'Connection logged',
      });
    } catch (err) {
      next(err);
    }
  }
}
