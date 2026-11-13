import mongoose from 'mongoose';
import Investment, { IInvestmentDocument } from '../models/Investment';
import User from '../models/User';
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

    if (!title || typeof title !== 'string' || !title.trim() || title.length > 100) {
      throw new AppError('Le titre est requis (100 caractères max)', 400);
    }
    // The amount is debited from the wallet in the USER's currency: recording
    // the investment in a client-chosen currency (EUR) and crediting that same
    // number back to the XAF wallet on close mixed currencies.
    void currency;
    const user = await User.findById(userId).select('currency').lean();
    const walletCurrency = user?.currency || 'XAF';
    if (!type || !['crypto', 'stock', 'real_estate', 'other'].includes(type)) {
      throw new AppError("Type d'investissement invalide", 400);
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
          category: 'investment_purchase',
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
            currency: walletCurrency,
            history: [{ value: initialAmount, date: new Date() }],
          },
        ],
        { session },
      );

      return { investment, transaction };
    });

    (result.transaction as any)
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

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
    const result = await WalletService.runInTransaction(async (session) =>
      InvestmentService.settle(userId, investmentId, session, requestedValue),
    );
    (result.transaction as any)
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));
    logger.info(
      `[FINTECH] Investment ${investmentId} closed for user ${userId}. Credited: ${result.closingValue}`,
    );
    return result.investment;
  }

  /**
   * Shared by close and delete: atomically flips the investment to 'closed'
   * (the status guard IS the update filter, so concurrent requests can credit
   * at most once) and credits the wallet with the server's current value.
   */
  private static async settle(
    userId: string,
    investmentId: string,
    session: mongoose.ClientSession,
    requestedValue?: number,
  ) {
    const existing = await Investment.findOne({ _id: investmentId, userId }).session(session);
    if (!existing) throw new AppError('Investment not found', 404);

    const investment = await Investment.findOneAndUpdate(
      { _id: investmentId, userId, status: { $ne: 'closed' } },
      {
        $set: { status: 'closed', lastUpdated: new Date() },
        $push: { history: { value: existing.currentValue, date: new Date() } },
      },
      { new: true, session },
    );
    if (!investment) throw new AppError('Investment is already closed', 400);

    if (typeof requestedValue === 'number' && requestedValue !== investment.currentValue) {
      logger.warn(
        `[FINTECH] closeInvestment: client-supplied value ${requestedValue} ignored for investment ${investmentId}; using server value ${investment.currentValue}`,
      );
    }

    const closingValue = investment.currentValue;
    let transaction: any = null;
    if (closingValue > 0) {
      // Internal credit through the wallet ledger (audited, notified) instead
      // of a bare $inc on the balance.
      transaction = await WalletService.executeTransaction(
        {
          userId,
          amount: closingValue,
          type: 'deposit',
          category: 'investment_close',
          description: `Clôture investissement: ${investment.title}`,
          paymentMethod: 'wallet',
          reference: `INV-CLOSE-${investmentId}`,
          metadata: { investmentId, investmentType: investment.type },
        },
        { session },
      );
    }
    return { investment, transaction, closingValue };
  }

  /**
   * Delete an investment. An ACTIVE one is settled first at its CURRENT value,
   * exactly like a close: refunding the initial amount let a user dodge any
   * loss (a 10 000 position worth 5 000 deleted for a 10 000 refund).
   */
  static async deleteInvestment(id: string, userId: string) {
    const result = await WalletService.runInTransaction(async (session) => {
      const investment = await Investment.findOne({ _id: id, userId }).session(session);
      if (!investment) {
        throw new AppError('Investment not found', 404);
      }
      let transaction: any = null;
      if (investment.status !== 'closed') {
        ({ transaction } = await InvestmentService.settle(userId, id, session));
      }
      await Investment.findOneAndDelete({ _id: id, userId }, { session });
      return transaction;
    });

    (result as any)
      ?._postCommit?.()
      .catch((err: any) => logger.error(`Post-commit hook error: ${err.message}`));

    return true;
  }

  /**
   * Admin: List all investments across all users with user details and filters
   */
  static async listAllInvestments(query: {
    status?: string;
    type?: string;
    page?: number;
    limit?: number;
  }) {
    const filter: Record<string, any> = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [investments, total] = await Promise.all([
      Investment.find(filter)
        .populate('userId', 'firstName lastName email currency')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Investment.countDocuments(filter),
    ]);

    return {
      investments,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }
}
