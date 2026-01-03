import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import validate from '../middleware/validation';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/authValidator';
import protect from '../middleware/auth';

const router = Router();

router.post('/register', validate(registerSchema), AuthController.register);
router.post('/login', validate(loginSchema), AuthController.login);
router.post('/refresh', validate(refreshTokenSchema), AuthController.refresh);
router.post('/firebase', AuthController.firebaseAuth);
router.post('/google', AuthController.firebaseAuth); // Alias for backward compatibility

router.post('/forgot-password', AuthController.forgotPassword);
router.patch('/reset-password/:token', AuthController.resetPassword);
router.get('/verify-email', AuthController.verifyEmail);

// Protected routes
router.use(protect);
router.get('/me', AuthController.getMe);
router.post('/logout', AuthController.logout);
router.post('/fcm-token', AuthController.updateFCMToken);
router.post('/link-phone', AuthController.linkPhoneNumber);

export default router;
