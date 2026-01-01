import { Router } from 'express';
import { InsightController } from '../controllers/insightController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/spending', InsightController.getAnalysis);

export default router;
