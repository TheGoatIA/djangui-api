import { Router } from 'express';
import { UploadController } from '../controllers/uploadController';
import { upload } from '../config/multer';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);

// Same OCRService.scanReceipt Gemini call as the premium-gated POST /ocr/scan —
// without premiumOnly here, any free-tier user could use the paid OCR feature for
// free through this second entry point.
router.post('/receipt', premiumOnly, upload.single('receipt'), UploadController.scanReceipt);
router.post('/avatar', upload.single('avatar'), UploadController.uploadAvatar);
router.post('/document', upload.single('document'), UploadController.uploadDocument);

export default router;
