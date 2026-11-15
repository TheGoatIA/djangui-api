import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PremiumController } from '../controllers/premiumController';
import { protect, premiumOnly } from '../middleware/auth';
import { createRateLimitStore, createRateLimitHandler } from '../utils/rateLimitStore';

const router = Router();

// All routes are protected and premium only
router.use(protect);
router.use(premiumOnly);

// Chaque appel analyse 3 mois de transactions via Gemini (coût réel) — sans
// limite dédiée, seul le rate-limiter global (1000 req/15min par IP, partagé
// avec toute l'API) protège cet endpoint, ce qui est bien trop permissif pour
// une opération de ce coût. Même logique que ocrLimiter (ocr.routes.ts).
const autoBudgetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Trop de générations de budget IA, veuillez réessayer plus tard',
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('auto-budget'),
  handler: createRateLimitHandler('auto-budget'),
});

router.get('/auto-budget', autoBudgetLimiter, PremiumController.generateAutoBudget);
router.get('/report', PremiumController.getMonthlyReport);

export default router;
