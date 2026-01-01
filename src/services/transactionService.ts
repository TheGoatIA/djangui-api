import Transaction, { ITransactionDocument } from '../models/Transaction';
import Budget from '../models/Budget';
import SavingGoal from '../models/SavingGoal';
import { CategorizationService } from './ai/categorizationService';
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
                    data.merchant
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
                        (c) => c.name.toLowerCase() === transaction.category.toLowerCase()
                    );

                    if (categoryIndex !== -1) {
                        budget.categories[categoryIndex].spent += transaction.amount;
                        budget.totalSpent += transaction.amount;

                        if (budget.categories[categoryIndex].spent > budget.categories[categoryIndex].allocated) {
                            budget.status = 'exceeded';
                            // TODO: Trigger notification
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
            { new: true, runValidators: true }
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
}
