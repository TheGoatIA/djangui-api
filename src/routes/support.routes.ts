import express from 'express';
import * as SupportController from '../controllers/supportController';
import { protect } from '../middleware/auth';

const router = express.Router();

router.use(protect);

router.post('/tickets', SupportController.createTicket);
router.get('/tickets', SupportController.getUserTickets);
router.post('/tickets/:id/reply', SupportController.replyTicketUser);

export default router;
