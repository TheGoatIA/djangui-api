import { Router } from 'express';
import authRoutes from './auth.routes';
import transactionRoutes from './transaction.routes';
import budgetRoutes from './budget.routes';
import goalRoutes from './goal.routes';
import coachRoutes from './coach.routes';
import insightRoutes from './insight.routes';
import challengeRoutes from './challenge.routes';
import paymentRoutes from './payment.routes';
import { WebhookController } from '../controllers/webhookController';

const router = Router();

router.use('/auth', authRoutes);
router.use('/transactions', transactionRoutes);
router.use('/budgets', budgetRoutes);
router.use('/goals', goalRoutes);
router.use('/coach', coachRoutes);
router.use('/insights', insightRoutes);
router.use('/challenges', challengeRoutes);
router.use('/payments', paymentRoutes);

// Webhooks
router.post('/webhooks/stripe', WebhookController.stripeWebhook);
router.post('/webhooks/notchpay', WebhookController.notchpayWebhook);

export default router;
