import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import protect from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import validate from '../middleware/validation';
import {
  checkoutStripeSchema,
  initNotchPaySchema,
  payWithWalletSchema,
} from '../validators/paymentValidator';

const router = Router();

router.use(protect);

router.post(
  '/pay/wallet',
  idempotency,
  validate(payWithWalletSchema),
  PaymentController.payWithWallet,
);
router.post(
  '/checkout/stripe',
  idempotency,
  validate(checkoutStripeSchema),
  PaymentController.checkoutStripe,
);
router.post(
  '/init/notchpay',
  idempotency,
  validate(initNotchPaySchema),
  PaymentController.initNotchPay,
);
router.get('/verify', (_req, res) => {
  res.status(400).json({ status: 'error', message: 'Référence de transaction requise.' });
});
router.get('/verify/:reference', PaymentController.verifyTransaction);
router.get('/', PaymentController.getMyPayments);
router.post('/cancel-subscription', PaymentController.cancelSubscription);

export default router;
