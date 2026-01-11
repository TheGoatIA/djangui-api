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
import emailRoutes from './email.routes';
import adminRoutes from './admin.routes';
import systemRoutes from './system.routes';
import notificationRoutes from './notification.routes';
import supportRoutes from './support.routes';
import voiceRoutes from './voice.routes';
import forecastRoutes from './forecast.routes';
import simulatorRoutes from './simulator.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/system', systemRoutes);
router.use('/admin', adminRoutes); // Admin routes
router.use('/notifications', notificationRoutes);
router.use('/support', supportRoutes);
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
router.use('/emails', emailRoutes);
router.use('/voice', voiceRoutes);
router.use('/forecast', forecastRoutes);
router.use('/simulator', simulatorRoutes);

// Webhooks
router.post('/webhooks/stripe', WebhookController.stripeWebhook);
router.post('/webhooks/notchpay', WebhookController.notchpayWebhook);

export default router;
