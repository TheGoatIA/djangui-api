import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { CountryRequestController } from '../controllers/countryRequestController';
import validate from '../middleware/validation';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/authValidator';
import protect from '../middleware/auth';
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 tentatives par IP par 15 minutes
  message: 'Trop de tentatives de connexion, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Dedicated rate limiter for token refresh — tighter than global to prevent abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Max 30 refresh attempts per IP — covers normal multi-device usage
  message: 'Trop de tentatives de rafraîchissement, veuillez réessayer dans 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), AuthController.register);
router.post('/login', authLimiter, validate(loginSchema), AuthController.login);
router.post('/refresh', refreshLimiter, validate(refreshTokenSchema), AuthController.refresh);
router.post('/firebase', AuthController.firebaseAuth);
router.post('/google', AuthController.firebaseAuth); // Alias for backward compatibility
router.post('/apple', AuthController.firebaseAuth); // Alias for Apple

router.post('/forgot-password', authLimiter, AuthController.forgotPassword);
router.patch('/reset-password/:token', AuthController.resetPassword);
router.get('/verify-email', AuthController.verifyEmail);
router.post('/resend-verification', AuthController.resendVerificationEmail);

// Protected routes
router.use(protect);
router.get('/me', AuthController.getMe);
router.patch('/me', AuthController.updateMe);
router.patch('/language', AuthController.updateLanguage);
router.patch('/change-password', AuthController.changePassword);
router.delete('/delete-me', AuthController.deleteMe);
router.get('/sessions', AuthController.getSessions);
router.delete('/sessions/:sessionId', AuthController.revokeSession);
router.delete('/sessions', AuthController.revokeAllSessions);
router.post('/logout', AuthController.logout);
router.post('/fcm-token', AuthController.updateFCMToken);
router.post('/link-phone', AuthController.linkPhoneNumber);
router.patch('/device', AuthController.updateDeviceInfo);
router.post('/connection', AuthController.logConnection);
router.post('/request-country-change', CountryRequestController.requestChange);

export default router;
