import { Router } from 'express';
import { ResellerController } from '../controllers/resellerController';
import { protect } from '../middleware/auth';
import {
  checkAccountQuota,
  checkSlotQuota,
  requireBusinessPlan,
} from '../middleware/resellerQuota';

const router = Router();

// All reseller routes require authentication
router.use(protect);

// 1. Catalog & Presets
router.get('/catalog', ResellerController.getCatalog);

// 2. Dashboard & Analytics
router.get('/dashboard', ResellerController.getDashboard);
router.get('/export', requireBusinessPlan, ResellerController.exportCsv);

// 3. Master Accounts
router.get('/accounts', ResellerController.listAccounts);
router.post('/accounts', checkAccountQuota, ResellerController.createAccount);
router.get('/accounts/:id', ResellerController.getAccountDetails);
router.patch('/accounts/:id', ResellerController.updateAccount);
router.delete('/accounts/:id', ResellerController.deleteAccount);
router.get('/accounts/:id/vault', ResellerController.unlockVault);

// 4. Slots / Client Profiles
router.post('/accounts/:accountId/slots', checkSlotQuota, ResellerController.addSlot);
router.patch('/slots/:slotId', ResellerController.updateSlot);
router.delete('/slots/:slotId', ResellerController.deleteSlot);
router.post('/slots/:slotId/pay', ResellerController.recordPayment);
router.get('/slots/:slotId/whatsapp-link', ResellerController.getWhatsAppReminderLink);
router.post('/slots/:slotId/remind', ResellerController.triggerReminder);

export default router;
