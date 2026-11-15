import { Router } from 'express';
import { InvestmentController } from '../controllers/investmentController';
import { protect, premiumOnly } from '../middleware/auth';
import { requireFeature } from '../middleware/featureFlag';

const router = Router();

router.use(protect);
router.use(premiumOnly);

// Opening a position requires the feature; listing/closing/deleting existing
// ones stays available so nobody's money is ever stuck.
router.post('/', requireFeature('feat_investments'), InvestmentController.create);
router.get('/', InvestmentController.list);
// PATCH /:id/value is admin-only — see routes/admin.routes.ts. It must never be
// reachable by the investment's own owner (see InvestmentService.updateValue).
router.post('/:id/close', InvestmentController.close);
router.delete('/:id', InvestmentController.delete);

export default router;
