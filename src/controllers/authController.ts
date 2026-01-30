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
      const { idToken, country, currency } = req.body;
      if (!idToken) throw new AppError('Firebase ID token is required', 400);

      const result = await AuthService.firebaseAuth(idToken, { country, currency });
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
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).send('<h1>Lien invalide</h1><p>Le jeton de réinitialisation est manquant.</p>');
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Réinitialiser le mot de passe | Kauri</title>
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
          <style>
              :root {
                  --primary: #1DB954;
                  --primary-dark: #16a34a;
                  --bg: #0b0f14;
                  --surface: rgba(255, 255, 255, 0.05);
                  --text: #f8fafc;
                  --text-dim: #94a3b8;
                  --error: #ff4d4d;
                  --success: #1DB954;
              }

              * { margin: 0; padding: 0; box-sizing: border-box; }

              body {
                  font-family: 'Outfit', sans-serif;
                  background-color: var(--bg);
                  color: var(--text);
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  min-height: 100vh;
                  padding: 20px;
                  position: relative;
                  overflow: hidden;
              }

              .blob {
                  position: absolute;
                  width: 500px;
                  height: 500px;
                  background: linear-gradient(135deg, var(--primary), #0a522c);
                  filter: blur(80px);
                  border-radius: 50%;
                  z-index: -1;
                  opacity: 0.15;
                  animation: flow 20s infinite alternate;
              }
              .blob-1 { top: -200px; left: -100px; }
              .blob-2 { bottom: -200px; right: -100px; animation-delay: -10s; }

              @keyframes flow {
                  from { transform: translate(0, 0) scale(1); }
                  to { transform: translate(100px, 50px) scale(1.1); }
              }

              .card {
                  background: var(--surface);
                  backdrop-filter: blur(20px);
                  -webkit-backdrop-filter: blur(20px);
                  border: 1px solid rgba(255, 255, 255, 0.1);
                  padding: 2.5rem;
                  border-radius: 2rem;
                  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                  width: 100%;
                  max-width: 450px;
                  animation: fadeIn 0.8s ease-out;
              }

              @keyframes fadeIn {
                  from { opacity: 0; transform: translateY(20px); }
                  to { opacity: 1; transform: translateY(0); }
              }

              .logo {
                  width: 60px;
                  height: 60px;
                  background: linear-gradient(135deg, var(--primary), #FFD700);
                  margin: 0 auto 1.5rem;
                  border-radius: 16px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  font-size: 1.8rem;
                  font-weight: 800;
                  color: var(--bg);
                  box-shadow: 0 10px 20px rgba(29, 185, 84, 0.2);
              }

              h1 {
                  font-size: 1.8rem;
                  font-weight: 800;
                  margin-bottom: 0.5rem;
                  text-align: center;
                  background: linear-gradient(to right, #fff, var(--text-dim));
                  -webkit-background-clip: text;
                  -webkit-text-fill-color: transparent;
              }

              p.subtitle {
                  color: var(--text-dim);
                  text-align: center;
                  margin-bottom: 2rem;
                  font-size: 1rem;
              }

              .form-group { margin-bottom: 1.5rem; }

              label {
                  display: block;
                  margin-bottom: 0.5rem;
                  color: var(--text-dim);
                  font-size: 0.9rem;
                  font-weight: 600;
              }

              input {
                  width: 100%;
                  padding: 1rem;
                  background: rgba(255, 255, 255, 0.05);
                  border: 1px solid rgba(255, 255, 255, 0.1);
                  border-radius: 12px;
                  color: white;
                  font-family: inherit;
                  font-size: 1rem;
                  transition: all 0.3s;
              }

              input:focus {
                  outline: none;
                  border-color: var(--primary);
                  background: rgba(255, 255, 255, 0.1);
                  box-shadow: 0 0 0 4px rgba(29, 185, 84, 0.1);
              }

              .btn {
                  width: 100%;
                  padding: 1rem;
                  background: var(--primary);
                  color: var(--bg);
                  border: none;
                  border-radius: 12px;
                  font-size: 1rem;
                  font-weight: 800;
                  cursor: pointer;
                  transition: all 0.3s;
                  margin-top: 1rem;
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  gap: 10px;
              }

              .btn:hover {
                  background: var(--primary-dark);
                  transform: translateY(-2px);
                  box-shadow: 0 10px 20px rgba(29, 185, 84, 0.2);
              }

              .btn:disabled {
                  opacity: 0.6;
                  cursor: not-allowed;
                  transform: none;
              }

              .message {
                  margin-top: 1.5rem;
                  padding: 1rem;
                  border-radius: 12px;
                  font-size: 0.9rem;
                  text-align: center;
                  display: none;
              }

              .message.error {
                  display: block;
                  background: rgba(255, 77, 77, 0.1);
                  color: var(--error);
                  border: 1px solid rgba(255, 77, 77, 0.2);
              }

              .message.success {
                  display: block;
                  background: rgba(29, 185, 84, 0.1);
                  color: var(--success);
                  border: 1px solid rgba(29, 185, 84, 0.2);
              }

              .spinner {
                  width: 20px;
                  height: 20px;
                  border: 3px solid rgba(0,0,0,0.1);
                  border-top: 3px solid var(--bg);
                  border-radius: 50%;
                  animation: spin 1s linear infinite;
                  display: none;
              }

              @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
              }

              .loading .spinner { display: block; }
              .loading .btn-text { display: none; }
          </style>
      </head>
      <body>
          <div class="blob blob-1"></div>
          <div class="blob blob-2"></div>

          <div class="card">
              <div class="logo">K</div>
              <h1>Nouveau Départ</h1>
              <p class="subtitle">Choisissez un mot de passe fort pour sécuriser votre compte Kauri.</p>

              <form id="resetForm">
                  <div class="form-group">
                      <label for="password">Nouveau mot de passe</label>
                      <input type="password" id="password" placeholder="••••••••" required minlength="8">
                  </div>
                  <div class="form-group">
                      <label for="confirmPassword">Confirmer le mot de passe</label>
                      <input type="password" id="confirmPassword" placeholder="••••••••" required minlength="8">
                  </div>

                  <button type="submit" class="btn" id="submitBtn">
                      <span class="spinner"></span>
                      <span class="btn-text">Mettre à jour</span>
                  </button>
              </form>

              <div id="message" class="message"></div>
          </div>

          <script>
              const form = document.getElementById('resetForm');
              const submitBtn = document.getElementById('submitBtn');
              const message = document.getElementById('message');
              const token = "${token}";

              form.onsubmit = async (e) => {
                  e.preventDefault();
                  
                  const password = document.getElementById('password').value;
                  const confirmPassword = document.getElementById('confirmPassword').value;

                  if (password !== confirmPassword) {
                      showMessage("Les mots de passe ne correspondent pas.", "error");
                      return;
                  }

                  try {
                      setLoading(true);
                      const response = await fetch('/api/v1/auth/reset-password/' + token, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ password })
                      });

                      const data = await response.json();

                      if (response.ok) {
                          showMessage("Votre mot de passe a été réinitialisé avec succès ! Vous pouvez maintenant vous connecter sur l'application.", "success");
                          form.style.display = 'none';
                      } else {
                          showMessage(data.message || "Une erreur est survenue.", "error");
                      }
                  } catch (err) {
                      showMessage("Erreur de connexion au serveur.", "error");
                  } finally {
                      setLoading(false);
                  }
              };

              function showMessage(text, type) {
                  message.textContent = text;
                  message.className = 'message ' + type;
              }

              function setLoading(loading) {
                  submitBtn.disabled = loading;
                  if (loading) submitBtn.classList.add('loading');
                  else submitBtn.classList.remove('loading');
              }
          </script>
      </body>
      </html>
    `);
  }
}
