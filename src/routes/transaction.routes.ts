import { Router } from 'express';
import { TransactionController } from '../controllers/transactionController';
import { protect, premiumOnly } from '../middleware/auth';
import validate from '../middleware/validation';
import {
  createTransactionSchema,
  updateTransactionSchema,
} from '../validators/transactionValidator';
import multer from 'multer';

const upload = multer({ dest: 'uploads/' });

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
