import { Router } from 'express';
import { ForecastController } from '../controllers/forecastController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);
router.use(premiumOnly);

router.get('/balance', ForecastController.getBalanceForecast);

export default router;
