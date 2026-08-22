import mongoose from 'mongoose';
import Investment, { IInvestmentDocument } from '../models/Investment';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { AuditService } from './auditService';
import { WalletService } from './walletService';

export class InvestmentService {
  /**
   * Create a new investment. Only a whitelisted set of fields is accepted from
   * the client — `currentValue` is deliberately never one of them, it's always
   * seeded server-side from `initialAmount`. The initial amount is genuinely
   * debited from the wallet in the same transaction as the investment record,
   * so an "investment" always corresponds to real money actually locked in,
   * not a self-reported number that can later be closed for free credit.
   */
  static async createInvestment(
    userId: string,
    data: { title?: string; type?: string; initialAmount?: number; currency?: string },
  ) {
    const { title, type, initialAmount, currency } = data;

    if (!title || typeof title !== 'string') {
      throw new AppError('Le titre est requis', 400);
    }
    if (!type || !['crypto', 'stock', 'real_estate', 'other'].includes(type)) {
      throw new AppError('Type d\'investissement invalide', 400);
    }
    if (!Number.isFinite(initialAmount) || (initialAmount as number) <= 0) {
      throw new AppError('Montant initial invalide', 400);
    }

    const result = await WalletService.runInTransaction(async (session) => {
      const transaction = await WalletService.executeTransaction(
        {
          userId,
          amount: initialAmount as number,
          type: 'saving_transfer',
          description: `Investissement : ${title}`,
          paymentMethod: 'wallet',
          metadata: { action: 'investment_create' },
        },
        { session },
      );

      const [investment] = await Investment.create(
        [
          {
            userId,
            title,
            type,
            initialAmount,
            currentValue: initialAmount,
            currency: currency || 'XAF',
            history: [{ value: initialAmount, date: new Date() }],
          },
        ],
        { session },
      );

      return { investment, transaction };
    });

    (result.transaction as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    return result.investment;
  }

  /**
   * List investments for a user
   */
  static async listInvestments(userId: string, status?: string) {
    const filter: any = { userId };
    if (status) filter.status = status;
    return Investment.find(filter).sort({ createdAt: -1 });
  }

  /**
   * Update investment value and history — ADMIN ONLY (see routes/admin.routes.ts).
   * There is currently no live market-price feed wired up, so this is a manual
   * mark-to-market control. It must never be reachable by the investment's own
   * owner: `closeInvestment` credits the wallet with exactly this value, so an
   * end-user-writable `currentValue` would let anyone fabricate real wallet
   * balance by setting it arbitrarily high and then closing the investment.
   */
  static async updateValue(investmentId: string, newValue: number) {
    if (!Number.isFinite(newValue) || newValue < 0) {
      throw new AppError('Valeur invalide', 400);
    }

    const investment = await Investment.findById(investmentId);
    if (!investment) {
      throw new AppError('Investment not found', 404);
    }

    investment.currentValue = newValue;
    investment.lastUpdated = new Date();
    investment.history.push({ value: newValue, date: new Date() });

    // Calculate and record yield
    const yieldRatio = ((newValue - investment.initialAmount) / investment.initialAmount) * 100;
    MonitoringService.updateInvestmentYield(yieldRatio, investment.type);

    await investment.save();

    await AuditService.record({
      userId: investment.userId as any,
      action: 'INVESTMENT_VALUE_UPDATE',
      resource: 'INVESTMENT',
      resourceId: investmentId,
      status: 'success',
      metadata: { newValue },
    });

    return investment;
  }

  /**
   * Close an investment (sell/exit) and credit the wallet with its value.
   *
   * The credited amount is always the server's own last known `currentValue`
   * (set via updateValue), never a client-supplied figure — accepting an
   * arbitrary client amount here would let a user credit their wallet at will.
   * Atomic (single Mongoose session) and idempotent (status guard inside the
   * same session prevents a retry or duplicate request from crediting twice).
   */
  static async closeInvestment(userId: string, investmentId: string, requestedValue?: number) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const investment = await Investment.findOne({ _id: investmentId, userId }).session(
        session,
      );
      if (!investment) {
        throw new AppError('Investment not found', 404);
      }
      if (investment.status === 'closed') {
        throw new AppError('Investment is already closed', 400);
      }

      if (typeof requestedValue === 'number' && requestedValue !== investment.currentValue) {
        logger.warn(
          `[FINTECH] closeInvestment: client-supplied value ${requestedValue} ignored for investment ${investmentId}; using server value ${investment.currentValue}`,
        );
      }

      const closingValue = investment.currentValue;

      investment.status = 'closed';
      investment.lastUpdated = new Date();
      investment.history.push({ value: closingValue, date: new Date() });
      await investment.save({ session });

      await User.findByIdAndUpdate(
        userId,
        { $inc: { walletBalance: closingValue } },
        { session },
      );

      await Transaction.create(
        [
          {
            userId,
            amount: closingValue,
            currency: investment.currency || 'XAF',
            type: 'income',
            category: 'investment_close',
            description: `Clôture investissement: ${investment.title}`,
            status: 'completed',
            reference: `INV-CLOSE-${investmentId}`,
          },
        ],
        { session },
      );

      await AuditService.record({
        userId: userId as any,
        action: 'INVESTMENT_CLOSE',
        resource: 'INVESTMENT',
        resourceId: investmentId,
        status: 'success',
        metadata: { amount: closingValue, investmentType: investment.type },
      });

      await session.commitTransaction();
      logger.info(
        `[FINTECH] Investment ${investmentId} closed for user ${userId}. Credited: ${closingValue}`,
      );

      return investment;
    } catch (error: any) {
      await session.abortTransaction();
      logger.error(
        `[FINTECH] closeInvestment FAILED for investment ${investmentId} (user ${userId}): ${error.message}`,
      );
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Delete an investment. If it's still active (not yet closed via closeInvestment),
   * its initialAmount was genuinely debited from the wallet at creation — refund it
   * in the same transaction as the deletion so deleting an investment can't be used
   * to make the locked funds disappear.
   */
  static async deleteInvestment(id: string, userId: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const investment = await Investment.findOne({ _id: id, userId }).session(session);
      if (!investment) {
        throw new AppError('Investment not found', 404);
      }

      let transaction: any = null;
      if (investment.status !== 'closed') {
        transaction = await WalletService.executeTransaction(
          {
            userId,
            amount: investment.initialAmount,
            type: 'deposit',
            description: `Remboursement (Suppression Investissement) : ${investment.title}`,
            paymentMethod: 'wallet',
            metadata: { investmentId: id, action: 'investment_delete_refund' },
          },
          { session },
        );
      }

      await Investment.findOneAndDelete({ _id: id, userId }, { session });
      return transaction;
    });

    (result as any)?._postCommit?.().catch((err: any) =>
      logger.error(`Post-commit hook error: ${err.message}`),
    );

    return true;
  }
}
