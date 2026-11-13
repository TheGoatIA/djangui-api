import { Router } from 'express';
import { CoachController } from '../controllers/coachController';
import protect from '../middleware/auth';
import { aiQuota, maxTextLength } from '../middleware/aiQuota';

const router = Router();

router.use(protect);

// Every message is a paid Gemini call: size cap + per-user daily quota.
const coachGuards = [maxTextLength('message', 2000), aiQuota('coach', { free: 15, premium: 150 })];

router.post('/ask', ...coachGuards, CoachController.ask);
router.post('/ask/stream', ...coachGuards, CoachController.askStream);
router.get('/history', CoachController.getHistory);

export default router;
