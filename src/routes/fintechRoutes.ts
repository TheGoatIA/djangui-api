import express from 'express';
import { FintechController } from '../controllers/fintechController';
import { protect } from '../middleware/auth'; // On suppose que ce middleware existe déjà

const router = express.Router();

// Toutes les routes fintech sont protégées
router.use(protect);

router.get('/wallet/balance', FintechController.getBalance);
router.get('/wallet/transactions', FintechController.getTransactions);

router.post('/kyc/submit', FintechController.submitKYC);

router.post('/payout/withdraw', FintechController.requestWithdrawal);

router.get('/invoice/:transactionId', FintechController.getInvoice);

router.post('/challenge/deposit', FintechController.depositChallenge);

export default router;
