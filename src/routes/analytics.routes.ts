import express from 'express';
import { AnalyticsController } from '../controllers/analyticsController';
import { protect } from '../middleware/auth';

const router = express.Router();

router.use(protect);

router.post('/events', AnalyticsController.trackEvent);
router.post('/sessions/start', AnalyticsController.startSession);
router.post('/sessions/end', AnalyticsController.endSession);

export default router;
