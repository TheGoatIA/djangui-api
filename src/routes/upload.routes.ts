import { Router } from 'express';
import { UploadController } from '../controllers/uploadController';
import { upload } from '../config/multer';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.post('/receipt', upload.single('receipt'), UploadController.scanReceipt);
router.post('/avatar', upload.single('avatar'), UploadController.uploadAvatar);

export default router;
