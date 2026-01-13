import { Router } from 'express';
import { SubscriptionController } from '../controllers/subscriptionController';
import { protect } from '../middleware/auth';

const router = Router();

// Toutes les routes d'abonnements sont protégées
router.use(protect);

router.get('/', SubscriptionController.list);
router.post('/', SubscriptionController.create);
router.post('/detect', SubscriptionController.detect);
router.get('/:id', SubscriptionController.getDetails);
router.patch('/:id', SubscriptionController.update);
router.delete('/:id', SubscriptionController.delete);

export default router;
