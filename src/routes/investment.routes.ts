import { Router } from 'express';
import { InvestmentController } from '../controllers/investmentController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);
router.use(premiumOnly);

router.post('/', InvestmentController.create);
router.get('/', InvestmentController.list);
// PATCH /:id/value is admin-only — see routes/admin.routes.ts. It must never be
// reachable by the investment's own owner (see InvestmentService.updateValue).
router.post('/:id/close', InvestmentController.close);
router.delete('/:id', InvestmentController.delete);

export default router;
