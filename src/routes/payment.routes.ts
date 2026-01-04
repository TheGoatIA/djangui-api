import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/checkout/stripe', PaymentController.checkoutStripe);
router.post('/init/notchpay', PaymentController.initNotchPay);

export default router;
