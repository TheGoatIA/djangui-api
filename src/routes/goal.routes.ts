import { Router } from 'express';
import { GoalController } from '../controllers/goalController';
import protect from '../middleware/auth';
import validate from '../middleware/validation';
import { createGoalSchema, updateGoalSchema } from '../validators/goalValidator';

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
  .delete(GoalController.delete);

router.post('/:id/contribute', GoalController.addContribution);

export default router;
