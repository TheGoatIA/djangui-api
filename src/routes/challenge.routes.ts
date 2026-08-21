import { Router } from 'express';
import { ChallengeController } from '../controllers/challengeController';
import protect from '../middleware/auth';
import { upload } from '../config/multer';
import { idempotency } from '../middleware/idempotency';

const router = Router();

router.use(protect);

router.get('/', ChallengeController.getAll);
router.get('/my-challenges', ChallengeController.getUserChallenges);
router.post('/join', ChallengeController.join);
router.post('/deposit', idempotency, ChallengeController.depositMoney);
router.post('/:id/validate-week', idempotency, ChallengeController.validateWeek);
router.post('/:id/postpone', ChallengeController.postpone);
router.post('/:id/skip', ChallengeController.skip);
router.post('/:id/redeem', idempotency, ChallengeController.redeem);
// Le retrait rembourse le wallet (pénalité de sortie anticipée) — idempotence requise
router.delete('/:id', idempotency, ChallengeController.unjoin);

export default router;
