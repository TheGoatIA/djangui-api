import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/authService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from '../services/monitoringService';

export class AuthController {
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { user, tokens } = await AuthService.register(req.body);

      // Metrique business
      MonitoringService.recordUserSignup('email', req.body.country || 'unknown');

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
      const { idToken, country, currency, platform } = req.body;
      if (!idToken) throw new AppError('Firebase ID token is required', 400);

      const result = await AuthService.firebaseAuth(idToken, { country, currency, platform });

      // Metrique business (si nouvel utilisateur)
      if (result.isNewUser) {
        MonitoringService.recordUserSignup('firebase', country || 'unknown');
      }

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

  static async updateLanguage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { language } = req.body;
      if (!language || !['fr', 'en'].includes(language)) {
        throw new AppError('Invalid language. Supported: fr, en', 400);
      }

      const user = await AuthService.updateMe(req.user._id, { language });
      res.status(200).json({
        success: true,
        message: 'Language updated successfully',
        data: { language: user.language },
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
      const { refreshToken } = req.body;
      await AuthService.logout(req.user._id, refreshToken);

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
        return res.status(400).send(`
          <!DOCTYPE html>
          <html lang="fr">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Erreur de vérification</title>
              <style>
                  body { font-family: sans-serif; text-align: center; padding: 50px; background: #0b0f14; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                  .logo { width: 60px; height: 60px; background: #EF4444; color: #fff; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin-bottom: 24px; }
                  p { color: #94a3b8; max-width: 300px; line-height: 1.5; }
              </style>
          </head>
          <body>
              <div class="logo">X</div>
              <h1>Lien invalide</h1>
              <p>Le lien de vérification est invalide ou a expiré.</p>
          </body>
          </html>
        `);
      }

      await AuthService.verifyEmail(token);

      const deepLink = `kauri://login`;

      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Email vérifié</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background: #0b0f14; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .logo { width: 60px; height: 60px; background: #1DB954; color: #000; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin-bottom: 24px; }
                .btn { display: inline-block; padding: 14px 28px; background: #1DB954; color: #000; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 24px; }
                p { color: #94a3b8; max-width: 300px; line-height: 1.5; }
            </style>
        </head>
        <body>
            <div class="logo">K</div>
            <h1>Email vérifié avec succès !</h1>
            <p>Votre compte a été vérifié. Vous pouvez maintenant retourner à l'application pour vous connecter.</p>
            <a href="${deepLink}" class="btn">Aller à la page de connexion</a>
            <script>
                window.location.href = "${deepLink}";
                setTimeout(() => {
                    window.location.href = "${deepLink}";
                }, 500);
            </script>
        </body>
        </html>
      `);
    } catch (err: any) {
      res.status(400).send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Erreur de vérification</title>
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background: #0b0f14; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .logo { width: 60px; height: 60px; background: #EF4444; color: #fff; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin-bottom: 24px; }
                p { color: #94a3b8; max-width: 300px; line-height: 1.5; }
            </style>
        </head>
        <body>
            <div class="logo">X</div>
            <h1>Erreur</h1>
            <p>${err.message || 'Le lien de vérification est invalide ou a expiré.'}</p>
        </body>
        </html>
      `);
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
      const ConnectionLog = await import('../models/ConnectionLog').then((m) => m.default);

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
  static async resendVerificationEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      await AuthService.resendVerificationEmail(email);
      res.status(200).json({
        success: true,
        message: 'Email de vérification envoyé avec succès.',
      });
    } catch (err) {
      next(err);
    }
  }

  static async renderResetPasswordPage(req: Request, res: Response) {
    const token = req.params.token || (req.query.token as string);
    const deepLink = `kauri://reset-password?token=${token}`;

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Redirection Kauri</title>
          <style>
              body { font-family: sans-serif; text-align: center; padding: 50px; background: #0b0f14; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
              .logo { width: 60px; height: 60px; background: #1DB954; color: #000; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin-bottom: 24px; }
              .btn { display: inline-block; padding: 14px 28px; background: #1DB954; color: #000; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 24px; }
              p { color: #94a3b8; max-width: 300px; line-height: 1.5; }
          </style>
      </head>
      <body>
          <div class="logo">K</div>
          <h1>Ouverture de Kauri...</h1>
          <p>Si l'application ne s'ouvre pas, cliquez sur le bouton ci-dessous.</p>
          <a href="${deepLink}" class="btn">Ouvrir l'application</a>
          <script>
              window.location.href = "${deepLink}";
              setTimeout(() => {
                  window.location.href = "${deepLink}";
              }, 500);
          </script>
      </body>
      </html>
    `);
  }
}
