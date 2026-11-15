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
import { createRateLimitStore, createRateLimitHandler } from '../utils/rateLimitStore';

// Login / registration / 2FA. Many legitimate users share one public IP behind
// mobile-operator CGNAT, so the per-IP ceiling is deliberately generous: the
// real brute-force defence is the per-ACCOUNT lockout in AuthService.login.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  store: createRateLimitStore('auth'),
  message: 'Trop de tentatives de connexion, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('auth'),
});

// Endpoints that trigger an outgoing email or consume a single-use token
// (forgot-password, resend-verification, reset-password, verify-email): kept
// in their own bucket so email-spam protection does not eat into the login budget.
const emailFlowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  store: createRateLimitStore('auth-email'),
  message: 'Trop de demandes, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('auth-email'),
});

// Dedicated rate limiter for token refresh — tighter than global to prevent abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Max 30 refresh attempts per IP — covers normal multi-device usage
  store: createRateLimitStore('refresh'),
  message: 'Trop de tentatives de rafraîchissement, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('refresh'),
});

// 2FA setup/enable/disable only require `protect` (a valid session)
const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  store: createRateLimitStore('totp'),
  message: 'Trop de tentatives, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('totp'),
});

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login', authLimiter, validate(loginSchema), AuthController.login);
// Second step of login when the account has TOTP enabled
router.post('/2fa/verify', authLimiter, AuthController.verifyTotp);
router.post('/refresh', refreshLimiter, validate(refreshTokenSchema), AuthController.refresh);
router.post('/firebase', authLimiter, AuthController.firebaseAuth);
router.post('/google', authLimiter, AuthController.firebaseAuth); // Alias for backward compatibility
router.post('/apple', authLimiter, AuthController.firebaseAuth); // Alias for Apple

router.post('/forgot-password', emailFlowLimiter, AuthController.forgotPassword);
router.patch(
  '/reset-password/:token',
  emailFlowLimiter,
  validate(resetPasswordSchema),
  AuthController.resetPassword,
);
router.get('/verify-email', emailFlowLimiter, AuthController.verifyEmail);
router.post('/resend-verification', emailFlowLimiter, AuthController.resendVerificationEmail);

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
router.post(
  '/2fa/disable',
  totpLimiter,
  restrictTo('admin', 'support'),
  AuthController.disableTotp,
);
router.post('/logout', AuthController.logout);
router.post('/fcm-token', AuthController.updateFCMToken);
router.post('/link-phone', AuthController.linkPhoneNumber);
router.patch('/device', AuthController.updateDeviceInfo);
router.post('/connection', AuthController.logConnection);
router.post('/request-country-change', CountryRequestController.requestChange);

export default router;
