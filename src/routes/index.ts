import { Router } from 'express';
import authRoutes from './auth.routes';
import transactionRoutes from './transaction.routes';
import budgetRoutes from './budget.routes';
import goalRoutes from './goal.routes';
import coachRoutes from './coach.routes';
import insightRoutes from './insight.routes';
import challengeRoutes from './challenge.routes';
import ocrRoutes from './ocr.routes';
import smsRoutes from './sms.routes';
import paymentRoutes from './payment.routes';
import reportRoutes from './report.routes';
import uploadRoutes from './upload.routes';
import { WebhookController } from '../controllers/webhookController';
import investmentRoutes from './investment.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/transactions', transactionRoutes);
router.use('/budgets', budgetRoutes);
router.use('/goals', goalRoutes);
router.use('/coach', coachRoutes);
router.use('/insights', insightRoutes);
router.use('/challenges', challengeRoutes);
router.use('/ocr', ocrRoutes);
router.use('/sms', smsRoutes);
router.use('/payments', paymentRoutes);
router.use('/reports', reportRoutes);
router.use('/upload', uploadRoutes);
router.use('/investments', investmentRoutes);

// Webhooks
router.post('/webhooks/stripe', WebhookController.stripeWebhook);
router.post('/webhooks/notchpay', WebhookController.notchpayWebhook);

export default router;
