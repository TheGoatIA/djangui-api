import { Router } from 'express';
import { GoalController } from '../controllers/goalController';
import protect from '../middleware/auth';
import validate from '../middleware/validation';
import { createGoalSchema, updateGoalSchema } from '../validators/goalValidator';
import { idempotency } from '../middleware/idempotency';

const router = Router();

router.use(protect);

router
  .route('/')
  .get(GoalController.getAll)
  .post(validate(createGoalSchema), GoalController.create);

router
  .route('/:id')
  .get(GoalController.getOne)
  .put(validate(updateGoalSchema), GoalController.update)
  // Le retrait déclenche un remboursement wallet (WalletService) — idempotence requise
  .delete(idempotency, GoalController.delete);

router.post('/:id/contribute', idempotency, GoalController.addContribution);
router.post('/:id/redeem', idempotency, GoalController.redeem);

export default router;
