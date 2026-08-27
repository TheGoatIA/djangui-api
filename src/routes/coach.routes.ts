import { Router } from 'express';
import { CoachController } from '../controllers/coachController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/ask', CoachController.ask);
router.post('/ask/stream', CoachController.askStream);
router.get('/history', CoachController.getHistory);

export default router;
