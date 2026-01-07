import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/checkout/stripe', PaymentController.checkoutStripe);
router.post('/init/notchpay', PaymentController.initNotchPay);
router.get('/verify/:reference', PaymentController.verifyTransaction);
router.get('/', PaymentController.getMyPayments);
router.post('/cancel-subscription', PaymentController.cancelSubscription);

export default router;
