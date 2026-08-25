import { Router } from 'express';
import { SubscriptionController } from '../controllers/subscriptionController';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

// Route publique pour consulter les forfaits Kauri et tous leurs avantages
router.get('/plans', SubscriptionController.getPlansConfig);

// Toutes les autres routes d'abonnements sont protégées
router.use(protect);

router.get('/', SubscriptionController.list);
router.post('/', SubscriptionController.create);
router.post('/detect', SubscriptionController.detect);
// Modification des tarifs et caractéristiques réservée strictement aux administrateurs
router.patch('/plans/:slug', restrictTo('admin'), SubscriptionController.updatePlanConfig);
router.get('/:id', SubscriptionController.getDetails);
router.patch('/:id', SubscriptionController.update);
router.delete('/:id', SubscriptionController.delete);

export default router;

