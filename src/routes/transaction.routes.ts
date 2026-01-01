import { Router } from 'express';
import { TransactionController } from '../controllers/transactionController';
import protect from '../middleware/auth';
import validate from '../middleware/validation';
import { createTransactionSchema, updateTransactionSchema } from '../validators/transactionValidator';

const router = Router();

router.use(protect);

router.route('/')
    .get(TransactionController.getAll)
    .post(validate(createTransactionSchema), TransactionController.create);

router.route('/:id')
    .get(TransactionController.getOne)
    .put(validate(updateTransactionSchema), TransactionController.update)
    .delete(TransactionController.delete);

export default router;
