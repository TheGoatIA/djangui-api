import { Router } from 'express';
import { EmailController } from '../controllers/emailController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/send', EmailController.sendAnyEmail);

export default router;
