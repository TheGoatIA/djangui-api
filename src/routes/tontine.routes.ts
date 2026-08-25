import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { TontineController } from '../controllers/tontineController';
import { protect, restrictTo } from '../middleware/auth';
import { upload, validateFileMagicBytes, uploadVoice, validateVoiceMagicBytes } from '../config/multer';
import { idempotency } from '../middleware/idempotency';

const router = Router();

// Invite codes are short strings — throttle join attempts per-IP to make brute-forcing
// a valid code impractical.
const joinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Max 15 join attempts per IP per 15 minutes
  message: 'Trop de tentatives, veuillez réessayer plus tard.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes protégées par authentification
router.use(protect);

router.get('/', TontineController.getUserTontines);
router.post('/', TontineController.create);
router.get('/:id', TontineController.getDetails);
router.patch('/:id', TontineController.update);
router.delete('/:id', TontineController.delete);
router.post('/:id/start', TontineController.start);
router.post('/:id/rotation/next', TontineController.rotateTurnNow);
router.post('/:id/social-fund/pay', TontineController.paySocialFund);
router.post('/join', joinLimiter, TontineController.join);
router.post(
  '/contribute',
  upload.single('receipt'),
  validateFileMagicBytes,
  idempotency,
  TontineController.contribute,
);

// Messagerie
router.post(
  '/:id/messages',
  uploadVoice.single('audio'),
  validateVoiceMagicBytes,
  TontineController.postMessage,
);
router.get('/:id/messages', TontineController.getMessages);
router.get('/:id/export', TontineController.exportReport);
router.get('/:id/members', TontineController.getMembers);
router.get('/:id/contributions', TontineController.getContributions);
router.patch(
  '/:id/contributions/:contributionId/validate',
  TontineController.validateContribution,
);
router.delete('/:id/members/:memberId', TontineController.removeMember);
router.patch('/:id/members/:memberId/auto-debit/toggle', TontineController.toggleAutoDebit);

// Gouvernance (Votes)
router.post('/:id/votes', TontineController.createVote);
router.post('/:id/votes/:voteId', TontineController.castVote);

// --- Routes Admin ---
router.get('/admin/stats', restrictTo('admin'), TontineController.getAdminStats);
router.get('/admin/all', restrictTo('admin'), TontineController.getAllTontines);
router.get('/admin/all/:id', restrictTo('admin'), TontineController.getAdminTontineDetails);

export default router;
