import { Router } from 'express';
import { CoachController } from '../controllers/coachController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/ask', CoachController.ask);
router.get('/history', CoachController.getHistory);

export default router;
