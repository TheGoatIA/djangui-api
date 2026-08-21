import express from 'express';
import { AdminController } from '../controllers/adminController';
import { CountryController } from '../controllers/countryController';
import { CountryRequestController } from '../controllers/countryRequestController';
import { FeatureFlagController } from '../controllers/featureFlagController';
import * as SupportController from '../controllers/supportController';
import { protect, restrictTo } from '../middleware/auth';

const router = express.Router();

// Toutes les routes admin necessitent une authentification
router.use(protect);

// Lecture seule : admin + support
router.get('/stats', restrictTo('admin', 'support'), AdminController.getDashboardStats);
router.get('/users', restrictTo('admin', 'support'), AdminController.getAllUsers);
router.get('/users/:id', restrictTo('admin', 'support'), AdminController.getUserDetails);
router.get('/transactions', restrictTo('admin', 'support'), AdminController.getAllTransactions);
router.get('/goals', restrictTo('admin', 'support'), AdminController.getAllGoals);
router.get('/tontines', restrictTo('admin', 'support'), AdminController.getAllTontines);
router.get('/tontines/:id', restrictTo('admin', 'support'), AdminController.getTontineDetails);
router.get('/subscriptions', restrictTo('admin', 'support'), AdminController.getAllSubscriptions);
router.get('/subscriptions/:id', restrictTo('admin', 'support'), AdminController.getSubscriptionDetails);
router.get('/settings', restrictTo('admin', 'support'), AdminController.getSystemSettings);
router.get('/feature-flags', restrictTo('admin', 'support'), FeatureFlagController.getAllFlags);
router.get('/countries', restrictTo('admin', 'support'), CountryController.getAllCountries);
router.get('/country-requests', restrictTo('admin', 'support'), CountryRequestController.listRequests);
router.get('/health', restrictTo('admin', 'support'), AdminController.getSystemHealth);
router.get('/db/stats', restrictTo('admin', 'support'), AdminController.getDatabaseStats);
router.get('/logs', restrictTo('admin', 'support'), AdminController.getLogs);
router.get('/logs/:filename', restrictTo('admin', 'support'), AdminController.downloadLog);
router.get('/analytics/financials', restrictTo('admin', 'support'), AdminController.getFinancialAnalytics);
router.get('/resources', restrictTo('admin', 'support'), AdminController.getServerResources);
router.get('/audit-logs', restrictTo('admin', 'support'), AdminController.getAuditLogs);
router.get('/connections', restrictTo('admin', 'support'), AdminController.getConnectionLogs);
router.get('/ai/stats', restrictTo('admin', 'support'), AdminController.getAIUsageStats);
router.get('/ai/logs', restrictTo('admin', 'support'), AdminController.getAIUsageLogs);
router.get('/analytics/dashboard', restrictTo('admin', 'support'), AdminController.getAnalyticsDashboard);
router.get('/support/tickets', restrictTo('admin', 'support'), SupportController.getAllTickets);

// KYC - lecture support autorisee, validation admin seule
router.get('/kyc/pending', restrictTo('admin', 'support'), AdminController.getKycPendingUsers);
router.patch('/kyc/:userId/validate', restrictTo('admin'), AdminController.validateKyc);
router.patch('/kyc/:userId/reject', restrictTo('admin'), AdminController.rejectKyc);

// Wallet Ledger - lecture seule support + admin
router.get('/wallet/ledger', restrictTo('admin', 'support'), AdminController.getWalletLedger);
router.get('/wallet/ledger/:userId', restrictTo('admin', 'support'), AdminController.getUserWalletLedger);

// Payouts - lecture support, actions admin seul
router.get('/payouts', restrictTo('admin', 'support'), AdminController.getPayouts);
router.get('/payouts/:id', restrictTo('admin', 'support'), AdminController.getPayoutDetails);
router.post('/payouts/:id/retry', restrictTo('admin'), AdminController.retryPayout);

// Actions destructives ou sensibles : admin seul
router.patch('/users/:id', restrictTo('admin'), AdminController.updateUser);
router.patch('/users/:id/status', restrictTo('admin'), AdminController.updateUserStatus);
router.post('/notifications/send', restrictTo('admin'), AdminController.sendPushNotification);
router.post('/notifications/email', restrictTo('admin'), AdminController.sendEmail);
router.post('/challenges', restrictTo('admin'), AdminController.createChallenge);
router.patch('/challenges/:id', restrictTo('admin'), AdminController.updateChallenge);
router.delete('/challenges/:id', restrictTo('admin'), AdminController.deleteChallenge);
router.patch('/settings', restrictTo('admin'), AdminController.updateSystemSetting);
router.post('/feature-flags', restrictTo('admin'), FeatureFlagController.createFlag);
router.patch('/feature-flags/:id', restrictTo('admin'), FeatureFlagController.updateFlag);
router.delete('/feature-flags/:id', restrictTo('admin'), FeatureFlagController.deleteFlag);
router.post('/countries', restrictTo('admin'), CountryController.addCountry);
router.patch('/countries/:id', restrictTo('admin'), CountryController.updateCountry);
router.patch('/country-requests/:id/process', restrictTo('admin'), CountryRequestController.processRequest);
router.delete('/goals/:id', restrictTo('admin'), AdminController.deleteGoal);
router.patch('/tontines/:id', restrictTo('admin'), AdminController.updateTontine);
router.patch('/subscriptions/:id', restrictTo('admin'), AdminController.updateSubscription);
router.get('/db/export', restrictTo('admin'), AdminController.exportDatabase);
router.get('/db/backup', restrictTo('admin'), AdminController.backupDatabase);
router.post('/db/restore/:filename', restrictTo('admin'), AdminController.restoreDatabase);
router.post('/logs', restrictTo('admin'), AdminController.createLog);
router.patch('/support/tickets/:id/status', restrictTo('admin', 'support'), SupportController.updateTicketStatus);
router.post('/support/tickets/:id/reply', restrictTo('admin', 'support'), SupportController.replyTicketAdmin);

export default router;
