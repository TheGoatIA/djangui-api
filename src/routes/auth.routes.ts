import { Router } from 'express';
import { AuthController } from '../controllers/authController';
import validate from '../middleware/validation';
import { registerSchema, loginSchema, refreshTokenSchema } from '../validators/authValidator';
import protect from '../middleware/auth';

const router = Router();

router.post('/register', validate(registerSchema), AuthController.register);
router.post('/login', validate(loginSchema), AuthController.login);
router.post('/refresh', validate(refreshTokenSchema), AuthController.refresh);

// Protected routes
router.use(protect);
router.post('/logout', AuthController.logout);

export default router;
