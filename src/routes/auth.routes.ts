import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import { CountryRequestController } from '../controllers/countryRequestController';
import validate from '../middleware/validation';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/authValidator';
import protect from '../middleware/auth';

const router = Router();

router.post('/register', validate(registerSchema), AuthController.register);
router.post('/login', validate(loginSchema), AuthController.login);
router.post('/refresh', validate(refreshTokenSchema), AuthController.refresh);
router.post('/firebase', AuthController.firebaseAuth);
router.post('/google', AuthController.firebaseAuth); // Alias for backward compatibility
router.post('/apple', AuthController.firebaseAuth); // Alias for Apple

router.post('/forgot-password', AuthController.forgotPassword);
router.patch('/reset-password/:token', AuthController.resetPassword);
router.get('/verify-email', AuthController.verifyEmail);

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
