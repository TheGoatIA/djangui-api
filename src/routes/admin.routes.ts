import express from 'express';
import { AdminController } from '../controllers/adminController';
import { CountryController } from '../controllers/countryController';
import { CountryRequestController } from '../controllers/countryRequestController';
import { protect, restrictTo } from '../middleware/auth';

const router = express.Router();

// Protect all routes after this middleware
router.use(protect);
router.use(restrictTo('admin'));

router.get('/stats', AdminController.getDashboardStats);
router.get('/users', AdminController.getAllUsers);
router.get('/users/:id', AdminController.getUserDetails); // Get User Details
router.patch('/users/:id', AdminController.updateUser); // Update User Profile
router.patch('/users/:id/status', AdminController.updateUserStatus);
router.post('/notifications/send', AdminController.sendPushNotification); // New route
router.post('/notifications/email', AdminController.sendEmail); // Admin Only Email

router.get('/transactions', AdminController.getAllTransactions);

// Challenges
router.post('/challenges', AdminController.createChallenge);
router.patch('/challenges/:id', AdminController.updateChallenge);
router.delete('/challenges/:id', AdminController.deleteChallenge);

// Settings
router.get('/settings', AdminController.getSystemSettings);
router.patch('/settings', AdminController.updateSystemSetting);

// Feature Flags
import { FeatureFlagController } from '../controllers/featureFlagController';
router.get('/feature-flags', FeatureFlagController.getAllFlags);
router.post('/feature-flags', FeatureFlagController.createFlag);
router.patch('/feature-flags/:id', FeatureFlagController.updateFlag);
router.delete('/feature-flags/:id', FeatureFlagController.deleteFlag);

// Country Management
router.get('/countries', CountryController.getAllCountries);
router.post('/countries', CountryController.addCountry);
router.patch('/countries/:id', CountryController.updateCountry);

// Country Change Requests
router.get('/country-requests', CountryRequestController.listRequests);
router.patch('/country-requests/:id/process', CountryRequestController.processRequest);

// Goals Management
router.get('/goals', AdminController.getAllGoals);
router.delete('/goals/:id', AdminController.deleteGoal);

// Tontines Management
router.get('/tontines', AdminController.getAllTontines);
router.get('/tontines/:id', AdminController.getTontineDetails);
router.patch('/tontines/:id', AdminController.updateTontine);

// Subscriptions Management
router.get('/subscriptions', AdminController.getAllSubscriptions);
router.get('/subscriptions/:id', AdminController.getSubscriptionDetails);
router.patch('/subscriptions/:id', AdminController.updateSubscription);

// System Management
router.get('/health', AdminController.getSystemHealth);
router.get('/db/stats', AdminController.getDatabaseStats);
router.get('/db/export', AdminController.exportDatabase);
router.get('/db/backup', AdminController.backupDatabase);
router.post('/db/restore/:filename', AdminController.restoreDatabase);
router.get('/logs', AdminController.getLogs);
router.post('/logs', AdminController.createLog);
router.get('/logs/:filename', AdminController.downloadLog);
router.get('/analytics/financials', AdminController.getFinancialAnalytics);
router.get('/resources', AdminController.getServerResources);
router.get('/audit-logs', AdminController.getAuditLogs);
router.get('/connections', AdminController.getConnectionLogs);

// AI Analytics
router.get('/ai/stats', AdminController.getAIUsageStats);
router.get('/ai/logs', AdminController.getAIUsageLogs);

// App Analytics
router.get('/analytics/dashboard', AdminController.getAnalyticsDashboard);

// Support & Tickets
import * as SupportController from '../controllers/supportController';
router.get('/support/tickets', SupportController.getAllTickets);
router.patch('/support/tickets/:id/status', SupportController.updateTicketStatus);
router.post('/support/tickets/:id/reply', SupportController.replyTicketAdmin);

export default router;
