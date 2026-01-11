import { Router } from 'express';
import { SimulatorController } from '../controllers/simulatorController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);
router.use(premiumOnly);

router.post('/what-if', SimulatorController.simulate);

export default router;
