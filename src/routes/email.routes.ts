import { Router } from 'express';
import { EmailController } from '../controllers/emailController';
import { protect, restrictTo } from '../middleware/auth';

const router = Router();

router.use(protect);

// Sends via the company's own Mailgun domain to an arbitrary `to` address with a
// fully client-supplied `html` body — previously reachable by any signed-up user,
// which made it an open relay for phishing/spam through Kauri's trusted sending
// domain. Restricted to admin/support, matching every other free-form outbound
// communication endpoint in the app.
router.post('/send', restrictTo('admin', 'support'), EmailController.sendAnyEmail);

export default router;
