import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { CountryRequestController } from '../controllers/countryRequestController';
import validate from '../middleware/validation';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  changePasswordSchema,
} from '../validators/authValidator';
import protect, { restrictTo } from '../middleware/auth';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from '../utils/rateLimitStore';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 tentatives par IP par 15 minutes
  store: createRateLimitStore('auth'),
  message: 'Trop de tentatives de connexion, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Dedicated rate limiter for token refresh — tighter than global to prevent abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Max 30 refresh attempts per IP — covers normal multi-device usage
  store: createRateLimitStore('refresh'),
  message: 'Trop de tentatives de rafraîchissement, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// 2FA setup/enable/disable only require `protect` (a valid session)
const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  store: createRateLimitStore('totp'),
  message: 'Trop de tentatives, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login', authLimiter, validate(loginSchema), AuthController.login);
// Second step of login when the account has TOTP enabled
router.post('/2fa/verify', authLimiter, AuthController.verifyTotp);
router.post('/refresh', refreshLimiter, validate(refreshTokenSchema), AuthController.refresh);
router.post('/firebase', AuthController.firebaseAuth);
router.post('/google', AuthController.firebaseAuth); // Alias for backward compatibility
router.post('/apple', AuthController.firebaseAuth); // Alias for Apple

router.post('/forgot-password', authLimiter, AuthController.forgotPassword);
router.patch(
  '/reset-password/:token',
  authLimiter,
  validate(resetPasswordSchema),
  AuthController.resetPassword,
);
router.get('/verify-email', authLimiter, AuthController.verifyEmail);
router.post('/resend-verification', authLimiter, AuthController.resendVerificationEmail);

// Protected routes
router.use(protect);
router.get('/me', AuthController.getMe);
router.patch('/me', AuthController.updateMe);
router.patch('/language', AuthController.updateLanguage);
router.patch('/change-password', validate(changePasswordSchema), AuthController.changePassword);
router.delete('/delete-me', AuthController.deleteMe);
router.get('/sessions', AuthController.getSessions);
router.delete('/sessions/:sessionId', AuthController.revokeSession);
router.delete('/sessions', AuthController.revokeAllSessions);
// Self-service TOTP 2FA management. Restricted to admin/support to match the
// only place 2FA is actually enforced (AuthService.login's role check) — a
// plain 'user' account could otherwise "enable" 2FA and be issued backup
// codes for a protection that silently never activates on login.
router.post('/2fa/setup', totpLimiter, restrictTo('admin', 'support'), AuthController.setupTotp);
router.post('/2fa/enable', totpLimiter, restrictTo('admin', 'support'), AuthController.enableTotp);
router.post('/2fa/disable', totpLimiter, restrictTo('admin', 'support'), AuthController.disableTotp);
router.post('/logout', AuthController.logout);
router.post('/fcm-token', AuthController.updateFCMToken);
router.post('/link-phone', AuthController.linkPhoneNumber);
router.patch('/device', AuthController.updateDeviceInfo);
router.post('/connection', AuthController.logConnection);
router.post('/request-country-change', CountryRequestController.requestChange);

export default router;
