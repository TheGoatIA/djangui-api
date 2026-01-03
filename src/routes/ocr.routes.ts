import { Router } from 'express';
import { OCRController } from '../controllers/ocrController';
import protect from '../middleware/auth';
import multer from 'multer';
import { AppError } from '../middleware/errorHandler';

const router = Router();
const upload = multer({
    dest: 'uploads/receipts/',
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new AppError('Seuls les images et les PDFs sont acceptés', 400));
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
    },
});

router.use(protect);

router.post('/scan', upload.single('receipt'), OCRController.scanReceipt);

export default router;
