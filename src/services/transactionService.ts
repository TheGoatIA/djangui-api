import Transaction, { ITransactionDocument } from '../models/Transaction';
import Budget from '../models/Budget';
import SavingGoal from '../models/SavingGoal';
import UserChallenge from '../models/UserChallenge';
import { CategorizationService } from './ai/categorizationService';
import { ChallengeService } from './challengeService';
import { GoalService } from './goalService';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import mongoose from 'mongoose';
import User from '../models/User';
import { SlackService } from './slackService';
import { MonitoringService } from './monitoringService';

export class TransactionService {
  static async createTransaction(userId: string, data: any) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // AI Categorization if category is missing OR explicitly requested
      if (data.type === 'expense' && (!data.category || data.category === 'Autres')) {
        const aiResult = await CategorizationService.categorize(
          data.description,
          data.amount,
          data.merchant,
        );
        data.category = aiResult.category;
        data.subcategory = aiResult.subcategory;
        data.isAutoCategorized = true;
        data.categorizationConfidence = aiResult.confidence;
      }

      const transaction = new Transaction({
        ...data,
        userId,
      });

      await transaction.save({ session });

      // Alert Slack for large transactions (> 500,000)
      if (transaction.amount > 500000) {
        SlackService.sendNotification(
          `💰 *Large Transaction Alert*\n*User ID*: ${userId}\n*Amount*: ${transaction.amount}\n*Type*: ${transaction.type}\n*Description*: ${transaction.description}`,
        );
      }

      // Update User Wallet Balance
      // Seuls les revenus numériques (dépôts) et les dépenses via Wallet impactent le solde réel.
      const incomeTypes = ['income', 'deposit', 'tontine_payout', 'challenge_reward'];
      const isDigitalIncome =
        incomeTypes.includes(data.type) &&
        ['stripe', 'notchpay', 'wallet'].includes(data.paymentMethod);
      const isWalletExpense = data.type === 'expense' && data.paymentMethod === 'wallet';

      if (isDigitalIncome) {
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: data.amount } }, { session });
      } else if (isWalletExpense || data.type === 'withdrawal') {
        const incValue = -data.amount;
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: incValue } }, { session });
      }

      // Apply automated saving strategies (e.g., Roundup)
      if (transaction.type === 'expense') {
        await TransactionService.applyAutomatedStrategies(userId, transaction, session);
      }

      // If expense, update budget
      if (transaction.type === 'expense') {
        const date = new Date(transaction.date);
        const month = date.getMonth() + 1;
        const year = date.getFullYear();

        const budget = await Budget.findOne({
          userId,
          'period.month': month,
          'period.year': year,
        }).session(session);

        if (budget) {
          const categoryIndex = budget.categories.findIndex(
            (c) => c.name.toLowerCase() === transaction.category.toLowerCase(),
          );

          if (categoryIndex !== -1) {
            budget.categories[categoryIndex].spent += transaction.amount;
            budget.totalSpent += transaction.amount;

            const usagePercentage =
              (budget.categories[categoryIndex].spent /
                budget.categories[categoryIndex].allocated) *
              100;

            if (usagePercentage >= 100 && budget.status !== 'exceeded') {
              budget.status = 'exceeded';
              NotificationService.sendToUser(userId, {
                title: '',
                body: '',
                translationKey: 'BUDGET_EXCEEDED',
                translationData: { category: budget.categories[categoryIndex].name },
                data: { type: 'budget_exceeded', category: budget.categories[categoryIndex].name },
              }).catch((err) => logger.error(`Notification error: ${err.message}`));
            } else if (usagePercentage >= 80 && usagePercentage < 100) {
              // Alert at 80%
              NotificationService.sendToUser(userId, {
                title: '',
                body: '',
                translationKey: 'BUDGET_WARNING',
                translationData: { category: budget.categories[categoryIndex].name },
                data: { type: 'budget_warning', category: budget.categories[categoryIndex].name },
              }).catch((err) => logger.error(`Notification error: ${err.message}`));
            }
            await (budget as any).save({ session });
          }
        }
      }

      // If linked to a goal, update goal
      if (transaction.linkedGoalId) {
        const goal = await SavingGoal.findById(transaction.linkedGoalId).session(session);
        if (goal) {
          if (transaction.type === 'income') {
            goal.currentAmount += transaction.amount;
          } else {
            goal.currentAmount -= transaction.amount;
          }
          const wasAlreadyHalfway =
            ((goal.currentAmount - transaction.amount) / goal.targetAmount) * 100 >= 50;
          const wasAlreadyCompleted =
            ((goal.currentAmount - transaction.amount) / goal.targetAmount) * 100 >= 100;

          await (goal as any).save({ session });

          // Check for milestones
          await GoalService.checkMilestones(userId, goal, wasAlreadyHalfway, wasAlreadyCompleted);
        }
      }

      await session.commitTransaction();

      // Metrique business - Move from controller to service for bulk coverage
      const metricType = (
        ['income', 'deposit', 'tontine_payout', 'challenge_reward'].includes(transaction.type)
          ? 'income'
          : 'expense'
      ) as 'income' | 'expense';

      MonitoringService.recordTransaction(
        metricType,
        'success',
        transaction.currency || 'XAF',
        transaction.amount,
      );

      // Background task: Update active challenges progress
      TransactionService.updateRelatedChallenges(
        userId,
        transaction.amount,
        metricType,
        transaction.category,
      ).catch((err: any) => {
        logger.error(`Error updating challenges progress: ${err.message}`);
      });

      return transaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getTransactions(userId: string, filters: any, pagination: any) {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const query: any = { userId };
    if (filters.type) query.type = filters.type;
    if (filters.category) query.category = filters.category;
    if (filters.startDate || filters.endDate) {
      query.date = {};
      if (filters.startDate) query.date.$gte = new Date(filters.startDate);
      if (filters.endDate) query.date.$lte = new Date(filters.endDate);
    }
    if (filters.search) {
      query.description = { $regex: filters.search, $options: 'i' };
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(query).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Transaction.countDocuments(query),
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  static async getTransactionById(id: string, userId: string) {
    const transaction = await Transaction.findOne({ _id: id, userId }).lean();
    if (!transaction) {
      throw new AppError('Transaction not found', 404);
    }
    return transaction;
  }

  static async updateTransaction(id: string, userId: string, data: any) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const oldTransaction = await Transaction.findOne({ _id: id, userId }).session(session);
      if (!oldTransaction) {
        throw new AppError('Transaction not found', 404);
      }

      // Revert old balance impact
      const wasDigitalIncome =
        oldTransaction.type === 'income' &&
        ['stripe', 'notchpay', 'wallet'].includes(oldTransaction.paymentMethod as any);
      const wasWalletExpense =
        oldTransaction.type === 'expense' && oldTransaction.paymentMethod === 'wallet';

      if (wasDigitalIncome) {
        await User.findByIdAndUpdate(
          userId,
          { $inc: { walletBalance: -oldTransaction.amount } },
          { session },
        );
      } else if (wasWalletExpense) {
        await User.findByIdAndUpdate(
          userId,
          { $inc: { walletBalance: oldTransaction.amount } },
          { session },
        );
      }

      // Apply changes
      const updatedTransaction = await Transaction.findByIdAndUpdate(
        id,
        { $set: data },
        { new: true, runValidators: true, session },
      );

      // Apply new balance impact
      if (updatedTransaction) {
        const isDigitalIncome =
          updatedTransaction.type === 'income' &&
          ['stripe', 'notchpay', 'wallet'].includes(updatedTransaction.paymentMethod as any);
        const isWalletExpense =
          updatedTransaction.type === 'expense' && updatedTransaction.paymentMethod === 'wallet';

        if (isDigitalIncome) {
          await User.findByIdAndUpdate(
            userId,
            { $inc: { walletBalance: updatedTransaction.amount } },
            { session },
          );
        } else if (isWalletExpense) {
          await User.findByIdAndUpdate(
            userId,
            { $inc: { walletBalance: -updatedTransaction.amount } },
            { session },
          );
        }
      }

      await session.commitTransaction();
      return updatedTransaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deleteTransaction(id: string, userId: string) {
    const transaction = await Transaction.findOne({ _id: id, userId });
    if (!transaction) {
      throw new AppError('Transaction not found', 404);
    }

    // Sécurité Fintech : Interdiction de supprimer des transactions réelles (Wallet, NotchPay, Stripe)
    if (transaction.paymentMethod !== 'cash') {
      throw new AppError(
        "Les transactions financières réelles ne peuvent pas être supprimées pour des raisons d'audit et d'intégrité.",
        403,
      );
    }

    await Transaction.deleteOne({ _id: id });
    return true;
  }

  static async bulkCreateTransactions(userId: string, transactionsData: any[]) {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as any[],
    };

    for (const data of transactionsData) {
      try {
        await this.createTransaction(userId, data);
        results.success++;
      } catch (err: any) {
        results.failed++;
        results.errors.push({
          data,
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * Apply automated saving strategies like Roundup
   */
  private static async applyAutomatedStrategies(userId: string, transaction: any, session?: any) {
    if (transaction.type !== 'expense') return;

    // Find goals with Roundup enabled
    const roundupGoal = await SavingGoal.findOne({
      userId,
      status: 'active',
      'autoSaveRules.enableRoundup': true,
    }).session(session);

    if (roundupGoal) {
      // Logic: Round up to the next 100 or 1000?
      // XAF context: next 100 is most common for small/medium expenses.
      const amount = transaction.amount;
      const threshold = amount > 1000 ? 1000 : 100;
      const remainder = threshold - (amount % threshold);
      const roundupAmount = remainder === threshold ? 0 : remainder;

      const wasAlreadyHalfway =
        ((roundupGoal.currentAmount - roundupAmount) / roundupGoal.targetAmount) * 100 >= 50;
      const wasAlreadyCompleted =
        ((roundupGoal.currentAmount - roundupAmount) / roundupGoal.targetAmount) * 100 >= 100;

      await (roundupGoal as any).save({ session });

      // Check for milestones
      await GoalService.checkMilestones(
        userId,
        roundupGoal,
        wasAlreadyHalfway,
        wasAlreadyCompleted,
      );

      logger.info(
        `Roundup strategy applied for user ${userId}: ${roundupAmount} added to goal ${roundupGoal.name}`,
      );
      MonitoringService.recordSavingsImpact(roundupAmount, 'roundup', 'XAF');
    }
  }

  private static async updateRelatedChallenges(
    userId: string,
    amount: number,
    type: 'income' | 'expense',
    category: string,
  ) {
    const activeChallenges = await UserChallenge.find({ userId, status: 'active' }).populate(
      'challengeId',
    );

    for (const userChallenge of activeChallenges) {
      const challenge = userChallenge.challengeId as any;
      let contribution = 0;

      if (challenge.type === 'saving' && type === 'income') {
        // For now, any income could be seen as potential saving if not spent?
        // Or maybe only specific 'saving' transactions.
        // Let's say saving challenges track absolute saving amount.
      } else if (challenge.type === 'spending_cut') {
        // If it's a spending cut in a specific category
        if (challenge.category && challenge.category.toLowerCase() === category.toLowerCase()) {
          // Logic for spending cut is usually: target is a limit.
          // This is more complex to track mid-transaction.
        }
      } else if (challenge.type === 'saving') {
        // Let's assume income counts as progress for saving goals/challenges for now
        if (type === 'income') contribution = amount;
      }

      if (contribution > 0) {
        await ChallengeService.updateProgress(userChallenge._id.toString(), contribution);
      }
    }
  }
}
