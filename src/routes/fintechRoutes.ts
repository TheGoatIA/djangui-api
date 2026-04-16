import express, { Response, NextFunction } from 'express';
import { FintechController } from '../controllers/fintechController';
import { protect, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = express.Router();

// Toutes les routes fintech sont protégées
router.use(protect);

/**
 * KYC guard middleware — rejects requests from users whose identity
 * has not been verified. Required for any operation involving real funds.
 */
const requireKYC = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.kycLevel !== 'verified') {
    return next(
      new AppError(
        'Votre identité doit être vérifiée (KYC) avant de pouvoir effectuer des retraits.',
        403,
      ),
    );
  }
  next();
};

router.get('/wallet/balance', FintechController.getBalance);
router.get('/wallet/transactions', FintechController.getTransactions);

router.post('/kyc/submit', FintechController.submitKYC);

// Withdrawal requires verified KYC
router.post('/payout/withdraw', requireKYC, FintechController.requestWithdrawal);

router.get('/invoice/:transactionId', FintechController.getInvoice);
router.get('/invoice/payment/:paymentId', FintechController.getPaymentInvoice);

router.post('/challenge/deposit', FintechController.depositChallenge);

export default router;
