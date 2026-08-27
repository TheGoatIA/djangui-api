import { Router } from 'express';
import { BudgetController } from '../controllers/budgetController';
import protect from '../middleware/auth';
import validate from '../middleware/validation';
import {
  createBudgetSchema,
  updateBudgetSchema,
  joinBudgetSchema,
} from '../validators/budgetValidator';

const router = Router();

router.use(protect);

router
  .route('/')
  .get(BudgetController.getAll)
  .post(validate(createBudgetSchema), BudgetController.create);

router.get('/current', BudgetController.getCurrent);
router.get('/history', BudgetController.getCategoryHistory);
router.post('/join', validate(joinBudgetSchema), BudgetController.join);

router
  .route('/:id')
  .put(validate(updateBudgetSchema), BudgetController.update)
  .delete(BudgetController.delete);

router.post('/:id/share', BudgetController.share);
router.post('/:id/leave', BudgetController.leave);
router.get('/:id/participants', BudgetController.getParticipants);
router.delete('/:id/participants/:participantId', BudgetController.removeParticipant);

export default router;
