import { Router } from 'express';
import authRoutes from './auth.routes';
import transactionRoutes from './transaction.routes';
import budgetRoutes from './budget.routes';
import goalRoutes from './goal.routes';
import coachRoutes from './coach.routes';
import insightRoutes from './insight.routes';
import challengeRoutes from './challenge.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/transactions', transactionRoutes);
router.use('/budgets', budgetRoutes);
router.use('/goals', goalRoutes);
router.use('/coach', coachRoutes);
router.use('/insights', insightRoutes);
router.use('/challenges', challengeRoutes);

export default router;
