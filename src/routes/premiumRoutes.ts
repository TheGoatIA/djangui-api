import { Router } from 'express';
import { PremiumController } from '../controllers/premiumController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

// All routes are protected and premium only
router.use(protect);
router.use(premiumOnly);

router.post('/auto-budget', PremiumController.generateAutoBudget);
router.get('/oracle', PremiumController.getOracleAlerts);
router.get('/report', PremiumController.getMonthlyReport);

export default router;
