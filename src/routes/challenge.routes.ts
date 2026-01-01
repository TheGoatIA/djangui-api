import { Router } from 'express';
import { ChallengeController } from '../controllers/challengeController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/', ChallengeController.getAll);
router.get('/my-challenges', ChallengeController.getUserChallenges);
router.post('/join', ChallengeController.join);

export default router;
