import { Router } from 'express';
import { TransactionController } from '../controllers/transactionController';
import { protect, premiumOnly } from '../middleware/auth';
import validate from '../middleware/validation';
import {
  createTransactionSchema,
  updateTransactionSchema,
} from '../validators/transactionValidator';
import multer from 'multer';

// Bulk transaction import only ever needs CSV/JSON, read once and discarded — cap
// size and reject any other file type to prevent a memory/CPU DoS via a huge or
// malformed upload (this instance previously had no fileFilter/limits at all).
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/csv', 'application/json', 'application/vnd.ms-excel'];
    if (allowed.includes(file.mimetype) || /\.(csv|json)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV or JSON files are allowed for bulk import.') as any, false);
    }
  },
});

const router = Router();

router.use(protect);

router
  .route('/')
  .get(TransactionController.getAll)
  .post(validate(createTransactionSchema), TransactionController.create);

router
  .route('/:id')
  .get(TransactionController.getOne)
  .put(validate(updateTransactionSchema), TransactionController.update)
  .delete(TransactionController.delete);

router.post('/bulk', premiumOnly, upload.single('file'), TransactionController.bulkUpload);

export default router;
