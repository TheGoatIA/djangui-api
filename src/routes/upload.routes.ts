import { Router } from 'express';
import { UploadController } from '../controllers/uploadController';
import { upload, validateFileMagicBytes } from '../config/multer';
import { protect, premiumOnly } from '../middleware/auth';
import rateLimit from 'express-rate-limit';

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // Max 30 file uploads per 15 minutes
  message: 'Trop de téléversements, veuillez réessayer plus tard',
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.use(protect);

router.post(
  '/receipt',
  uploadLimiter,
  premiumOnly,
  upload.single('receipt'),
  validateFileMagicBytes,
  UploadController.scanReceipt,
);
router.post(
  '/avatar',
  uploadLimiter,
  upload.single('avatar'),
  validateFileMagicBytes,
  UploadController.uploadAvatar,
);
router.post(
  '/avatar/generate',
  uploadLimiter,
  premiumOnly,
  UploadController.generateAvatar,
);
router.post(
  '/avatar/apply',
  uploadLimiter,
  premiumOnly,
  UploadController.applyGeneratedAvatar,
);
router.post(
  '/document',
  uploadLimiter,
  upload.single('document'),
  validateFileMagicBytes,
  UploadController.uploadDocument,
);

export default router;
