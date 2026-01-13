import { Router } from 'express';
import { TontineController } from '../controllers/tontineController';
import { protect, restrictTo } from '../middleware/auth';
import { upload } from '../config/multer';

const router = Router();

// Routes protégées par authentification
router.use(protect);

router.get('/', TontineController.getUserTontines);
router.post('/', TontineController.create);
router.get('/:id', TontineController.getDetails);
router.patch('/:id', TontineController.update);
router.delete('/:id', TontineController.delete);
router.post('/:id/start', TontineController.start);
router.post('/join', TontineController.join);
router.post('/contribute', upload.single('receipt'), TontineController.contribute);

// Messagerie
router.post('/:id/messages', TontineController.postMessage);
router.get('/:id/messages', TontineController.getMessages);
router.get('/:id/export', TontineController.exportReport);
router.get('/:id/members', TontineController.getMembers);
router.get('/:id/contributions', TontineController.getContributions);
router.delete('/:id/members/:memberId', TontineController.removeMember);

// Gouvernance (Votes)
router.post('/:id/votes', TontineController.createVote);
router.post('/:id/votes/:voteId', TontineController.castVote);

// --- Routes Admin ---
router.get('/admin/stats', restrictTo('admin'), TontineController.getAdminStats);
router.get('/admin/all', restrictTo('admin'), TontineController.getAllTontines);

export default router;
