import express from 'express';
import { NotificationController } from '../controllers/notificationController';
import { protect } from '../middleware/auth';

const router = express.Router();

// All notification routes are protected
router.use(protect);

router.get('/', NotificationController.getMyNotifications);
router.get('/unread-count', NotificationController.getUnreadCount);
router.patch('/mark-all-read', NotificationController.markAllAsRead);
router.patch('/:id/read', NotificationController.markAsRead);
router.delete('/:id', NotificationController.deleteNotification);

export default router;
