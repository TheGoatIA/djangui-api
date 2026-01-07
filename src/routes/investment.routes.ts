import { Router } from 'express';
import { InvestmentController } from '../controllers/investmentController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);
router.use(premiumOnly);

router.post('/', InvestmentController.create);
router.get('/', InvestmentController.list);
router.patch('/:id/value', InvestmentController.updateValue);
router.post('/:id/close', InvestmentController.close);
router.delete('/:id', InvestmentController.delete);

export default router;
