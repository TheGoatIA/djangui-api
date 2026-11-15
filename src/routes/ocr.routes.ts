import { Router } from 'express';
import { OCRController } from '../controllers/ocrController';
import { protect, premiumOnly } from '../middleware/auth';
import { upload, validateFileMagicBytes } from '../config/multer';
import rateLimit from 'express-rate-limit';
import { createRateLimitHandler } from '../utils/rateLimitStore';

const ocrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Max 20 OCR scans per 15 minutes to control Gemini API costs & abuse
  message: 'Trop de requêtes OCR/Scan, veuillez réessayer plus tard',
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler('ocr'),
});

const router = Router();

router.use(protect);

router.post(
  '/scan',
  ocrLimiter,
  premiumOnly,
  upload.single('receipt'),
  validateFileMagicBytes,
  OCRController.scanReceipt,
);

export default router;
