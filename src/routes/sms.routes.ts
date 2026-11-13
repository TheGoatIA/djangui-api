import { Router } from 'express';
import { SMSController } from '../controllers/smsController';
import protect from '../middleware/auth';
import { aiQuota, maxTextLength } from '../middleware/aiQuota';

const router = Router();

router.use(protect);

// Regex first, Gemini as fallback (paid): bounded size, count and daily quota.
const MAX_BULK = 50;
const bulkLimit = (req: any, res: any, next: any) => {
  const messages = req.body?.messages;
  if (Array.isArray(messages)) {
    if (messages.length > MAX_BULK) {
      return res
        .status(400)
        .json({ status: 'error', message: `${MAX_BULK} SMS maximum par import.` });
    }
    if (messages.some((m: unknown) => typeof m !== 'string' || m.length > 2000)) {
      return res.status(400).json({ status: 'error', message: 'SMS invalide ou trop long.' });
    }
  }
  next();
};

router.post(
  '/parse',
  maxTextLength('content', 2000),
  aiQuota('sms', { free: 30, premium: 300 }),
  SMSController.parse,
);
router.post(
  '/bulk-parse',
  bulkLimit,
  aiQuota('sms', { free: 30, premium: 300 }, (req) =>
    Array.isArray(req.body?.messages) ? req.body.messages.length : 1,
  ),
  SMSController.bulkParse,
);

export default router;
