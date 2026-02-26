import { Router } from 'express';
import { ChallengeController } from '../controllers/challengeController';
import protect from '../middleware/auth';
import { upload } from '../config/multer';

const router = Router();

router.use(protect);

router.get('/', ChallengeController.getAll);
router.get('/my-challenges', ChallengeController.getUserChallenges);
router.post('/join', ChallengeController.join);
router.post('/deposit', ChallengeController.depositMoney);
router.delete('/:id', ChallengeController.unjoin);

export default router;
