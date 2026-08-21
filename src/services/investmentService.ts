import mongoose from 'mongoose';
import Investment, { IInvestmentDocument } from '../models/Investment';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';
import { AuditService } from './auditService';

export class InvestmentService {
  /**
   * Create a new investment
   */
  static async createInvestment(userId: string, data: Partial<IInvestmentDocument>) {
    try {
      const investment = await Investment.create({
        ...data,
        userId,
        history: [{ value: data.initialAmount || 0, date: new Date() }],
      });

      return investment;
    } catch (error: any) {
      logger.error(`Error creating investment: ${error.message}`);
      throw error;
    }
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
   * Update investment value and history
   */
  static async updateValue(userId: string, investmentId: string, newValue: number) {
    const investment = await Investment.findOne({ _id: investmentId, userId });
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
   * Delete an investment
   */
  static async deleteInvestment(id: string, userId: string) {
    const investment = await Investment.findOneAndDelete({ _id: id, userId });
    if (!investment) {
      throw new AppError('Investment not found', 404);
    }
    return true;
  }
}
