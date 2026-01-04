import { Router } from 'express';
import { SMSController } from '../controllers/smsController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/parse', SMSController.parse);
router.post('/bulk-parse', SMSController.bulkParse);

export default router;
