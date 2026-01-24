import { Router } from 'express';
import { VoiceController } from '../controllers/voiceController';
import { protect, premiumOnly } from '../middleware/auth';
import multer from 'multer';
import { AppError } from '../middleware/errorHandler';
import fs from 'fs';

const router = Router();

// Ensure uploads directory exists
const uploadDir = 'uploads/voice/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/m4a',
      'audio/x-m4a',
      'audio/mp4',
      'audio/ogg',
      'audio/webm',
    ];
    if (allowedMimeTypes.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new AppError('Only audio files are accepted', 400));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

router.use(protect);

/**
 * @route POST /api/v1/voice/process
 * @desc Process a voice transaction
 * @access Premium
 */
router.post(
  '/process',
  premiumOnly,
  upload.single('audio'),
  VoiceController.processVoiceTransaction,
);

export default router;
