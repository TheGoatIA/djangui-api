import express from 'express';
import { AdminController } from '../controllers/adminController';
import { protect, restrictTo } from '../middleware/auth';

const router = express.Router();

// Protect all routes after this middleware
router.use(protect);
router.use(restrictTo('admin'));

router.get('/stats', AdminController.getDashboardStats);
router.get('/users', AdminController.getAllUsers);
router.patch('/users/:id/status', AdminController.updateUserStatus);
router.post('/notifications/send', AdminController.sendPushNotification); // New route

router.get('/transactions', AdminController.getAllTransactions);

// Challenges
router.post('/challenges', AdminController.createChallenge);
router.patch('/challenges/:id', AdminController.updateChallenge);
router.delete('/challenges/:id', AdminController.deleteChallenge);

// Settings
router.get('/settings', AdminController.getSystemSettings);
router.patch('/settings', AdminController.updateSystemSetting);

// System Management
router.get('/health', AdminController.getSystemHealth);
router.get('/db/backup', AdminController.backupDatabase);
router.get('/logs', AdminController.getLogs);
router.get('/logs/:filename', AdminController.downloadLog);
router.get('/analytics/financials', AdminController.getFinancialAnalytics);
router.get('/resources', AdminController.getServerResources);
router.get('/audit-logs', AdminController.getAuditLogs);

export default router;
