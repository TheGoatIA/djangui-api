import { Router } from 'express';
import { BudgetController } from '../controllers/budgetController';
import protect from '../middleware/auth';
import validate from '../middleware/validation';
import { createBudgetSchema, updateBudgetSchema } from '../validators/budgetValidator';

const router = Router();

router.use(protect);

router.route('/')
    .get(BudgetController.getAll)
    .post(validate(createBudgetSchema), BudgetController.create);

router.get('/current', BudgetController.getCurrent);

router.route('/:id')
    .put(validate(updateBudgetSchema), BudgetController.update);

export default router;
