import Transaction, { ITransactionDocument } from '../models/Transaction';
import Budget from '../models/Budget';
import SavingGoal from '../models/SavingGoal';
import UserChallenge from '../models/UserChallenge';
import { CategorizationService } from './ai/categorizationService';
import { ChallengeService } from './challengeService';
import { NotificationService } from './notificationService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import mongoose from 'mongoose';

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

            if (
              budget.categories[categoryIndex].spent > budget.categories[categoryIndex].allocated
            ) {
              budget.status = 'exceeded';

              // Send notification
              NotificationService.sendToUser(userId, {
                title: 'Budget Dépassé ! ⚠️',
                body: `Tu as dépassé ton budget pour la catégorie ${budget.categories[categoryIndex].name}.`,
                data: { type: 'budget_exceeded', category: budget.categories[categoryIndex].name },
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
          await (goal as any).save({ session });
        }
      }

      await session.commitTransaction();

      // Background task: Update active challenges progress
      TransactionService.updateRelatedChallenges(
        userId,
        transaction.amount,
        transaction.type,
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
    // Note: Updating a transaction might require complex logic to update budgets/goals
    // For now, let's implement basic update
    const transaction = await Transaction.findOneAndUpdate(
      { _id: id, userId },
      { $set: data },
      { new: true, runValidators: true },
    );

    if (!transaction) {
      throw new AppError('Transaction not found', 404);
    }

    return transaction;
  }

  static async deleteTransaction(id: string, userId: string) {
    const transaction = await Transaction.findOneAndDelete({ _id: id, userId });
    if (!transaction) {
      throw new AppError('Transaction not found', 404);
    }
    // TODO: Update budget/goal if necessary
    return true;
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
