import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import validate from '../middleware/validation';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/authValidator';
import protect from '../middleware/auth';

const router = Router();

router.post('/register', validate(registerSchema), AuthController.register);
router.post('/login', validate(loginSchema), AuthController.login);
router.post('/refresh', validate(refreshTokenSchema), AuthController.refresh);
router.post('/google', AuthController.googleAuth);

// Protected routes
router.use(protect);
router.get('/me', AuthController.getMe);
router.post('/logout', AuthController.logout);
router.post('/fcm-token', AuthController.updateFCMToken);

export default router;
