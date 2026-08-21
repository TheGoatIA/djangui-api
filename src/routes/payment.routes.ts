import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import protect from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';

const router = Router();

router.use(protect);

router.post('/checkout/stripe', idempotency, PaymentController.checkoutStripe);
router.post('/init/notchpay', idempotency, PaymentController.initNotchPay);
router.get('/verify/:reference', PaymentController.verifyTransaction);
router.get('/', PaymentController.getMyPayments);
router.post('/cancel-subscription', PaymentController.cancelSubscription);

export default router;
