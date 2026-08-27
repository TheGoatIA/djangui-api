import Transaction, { ITransactionDocument } from '../models/Transaction';
import Budget from '../models/Budget';
import BudgetParticipant from '../models/BudgetParticipant';
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

      // This method only ever creates transactions the user themselves entered
      // (manual form, SMS parsing, CSV/JSON import) — always their own currency,
      // never a client-supplied value, so currencyMiddleware can tell `amount`
      // is already native to that currency instead of assuming XAF (which
      // otherwise silently corrupts every manual transaction for a non-XAF user).
      const user = await User.findById(userId)
        .select('currency preferences.budgetAlertThreshold')
        .session(session);

      const transaction = new Transaction({
        ...data,
        userId,
        currency: user?.currency || 'XAF',
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
      // IMPORTANT: cette méthode ne crée que des transactions saisies par l'utilisateur
      // (formulaire manuel ou import CSV/JSON) — `type` ne doit donc jamais déclencher
      // ce crédit/débit en dehors de 'income'/'expense', les seules valeurs que le
      // validateur Joi autorise sur ce chemin. Des valeurs comme 'deposit'/'tontine_payout'/
      // 'withdrawal' sont réservées aux écritures système créées par WalletService
      // (paiements, tontines, retraits) — les accepter ici permettrait de fabriquer du
      // solde réel sans jamais passer par Stripe/NotchPay ou un vrai débit du wallet.
      const isDigitalIncome =
        data.type === 'income' && ['stripe', 'notchpay', 'wallet'].includes(data.paymentMethod);
      const isWalletExpense = data.type === 'expense' && data.paymentMethod === 'wallet';

      if (isDigitalIncome) {
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: data.amount } }, { session });
      } else if (isWalletExpense) {
        // Atomic conditional decrement: the schema's `min: 0` on walletBalance is not
        // enforced by $inc (no validators run), so without this floor check two
        // concurrent debits could each pass a separate stale-read balance check and
        // together drive the balance negative. A null result means insufficient funds.
        const debited = await User.findOneAndUpdate(
          { _id: userId, walletBalance: { $gte: data.amount } },
          { $inc: { walletBalance: -data.amount } },
          { session },
        );
        if (!debited) {
          throw new AppError('Solde insuffisant dans le portefeuille', 400);
        }
      }

      // Apply automated saving strategies (e.g., Roundup)
      if (transaction.type === 'expense') {
        await TransactionService.applyAutomatedStrategies(userId, transaction, session);
      }

      // If expense, update budget(s) — le budget propre, et tout budget
      // partagé où l'utilisateur est participant actif (voir BudgetParticipant).
      if (transaction.type === 'expense') {
        const date = new Date(transaction.date);
        const month = date.getMonth() + 1;
        const year = date.getFullYear();
        // Seuil d'alerte personnalisable (User.preferences.budgetAlertThreshold,
        // 80 par défaut) — utilisé pour le budget propre ET chaque budget partagé.
        const alertThreshold = user?.preferences?.budgetAlertThreshold ?? 80;

        const ownBudget = await Budget.findOne({
          userId,
          'period.month': month,
          'period.year': year,
        }).session(session);

        if (ownBudget) {
          await TransactionService.applyExpenseToBudget(
            ownBudget,
            transaction.category,
            transaction.amount,
            alertThreshold,
            [userId],
            session,
          );
        }

        const participations = await BudgetParticipant.find({
          userId,
          invitationStatus: 'accepted',
        })
          .select('budgetId')
          .session(session);

        if (participations.length > 0) {
          const sharedBudgets = await Budget.find({
            _id: { $in: participations.map((p) => p.budgetId) },
            'period.month': month,
            'period.year': year,
          }).session(session);

          for (const sharedBudget of sharedBudgets) {
            // Le propriétaire du budget partagé ET la personne qui vient de
            // dépenser sont notifiés (dédupliqués si c'est la même personne).
            const notifyIds = Array.from(
              new Set([sharedBudget.userId.toString(), userId.toString()]),
            );
            await TransactionService.applyExpenseToBudget(
              sharedBudget,
              transaction.category,
              transaction.amount,
              alertThreshold,
              notifyIds,
              session,
            );
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
    if (typeof filters.type === 'string') query.type = filters.type;
    if (typeof filters.category === 'string') query.category = filters.category;
    if (filters.startDate || filters.endDate) {
      query.date = {};
      if (filters.startDate) query.date.$gte = new Date(filters.startDate);
      if (filters.endDate) query.date.$lte = new Date(filters.endDate);
    }
    if (filters.search) {
      // Escape regex metacharacters: an unescaped pathological pattern submitted as
      // a search term can cause catastrophic backtracking on the MongoDB server.
      const escaped = String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.description = { $regex: escaped, $options: 'i' };
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
    const oldTransaction = await Transaction.findOne({ _id: id, userId });
    if (!oldTransaction) {
      throw new AppError('Transaction not found', 404);
    }

    // Sécurité Fintech (F01) : une transaction adossée à un mouvement réel de fonds
    // (Stripe, NotchPay, Wallet, Payout) est immuable.
    // Seules les transactions 'cash' saisies manuellement (qui n'impactent jamais walletBalance)
    // sont éditables.
    if (oldTransaction.paymentMethod && oldTransaction.paymentMethod !== 'cash') {
      throw new AppError(
        "Les transactions financières réelles ne peuvent pas être modifiées pour des raisons d'audit et d'intégrité.",
        403,
      );
    }

    // Whitelist des champs modifiables pour les transactions manuelles
    const ALLOWED_FIELDS = [
      'amount',
      'type',
      'category',
      'description',
      'date',
      'tags',
      'isRecurring',
      'metadata',
    ];
    const updateData: any = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in data) {
        updateData[key] = data[key];
      }
    }
    // Forcer le maintien du paymentMethod à 'cash'
    updateData.paymentMethod = 'cash';

    return Transaction.findOneAndUpdate(
      { _id: id, userId },
      { $set: updateData },
      { new: true, runValidators: true },
    );
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
   * Incrémente la catégorie correspondante d'un budget (propre ou partagé) et
   * notifie au(x) seuil(s) — factorisé pour être appliqué identiquement au
   * budget de l'utilisateur et à chacun des budgets partagés dont il est
   * participant (voir la boucle dans createTransaction ci-dessus).
   */
  private static async applyExpenseToBudget(
    budget: any,
    category: string,
    amount: number,
    alertThreshold: number,
    notifyUserIds: string[],
    session: mongoose.ClientSession,
  ) {
    const categoryIndex = budget.categories.findIndex(
      (c: any) => c.name.toLowerCase() === category.toLowerCase(),
    );
    if (categoryIndex === -1) return;

    budget.categories[categoryIndex].spent += amount;
    budget.totalSpent += amount;

    const usagePercentage =
      (budget.categories[categoryIndex].spent / budget.categories[categoryIndex].allocated) * 100;
    const categoryName = budget.categories[categoryIndex].name;

    const notify = (translationKey: string, type: string) => {
      for (const uid of notifyUserIds) {
        NotificationService.sendToUser(uid, {
          title: '',
          body: '',
          translationKey,
          translationData: { category: categoryName },
          data: { type, category: categoryName },
        }).catch((err: any) => logger.error(`Notification error: ${err.message}`));
      }
    };

    if (usagePercentage >= 100 && budget.status !== 'exceeded') {
      budget.status = 'exceeded';
      notify('BUDGET_EXCEEDED', 'budget_exceeded');
    } else if (usagePercentage >= alertThreshold && usagePercentage < 100) {
      notify('BUDGET_WARNING', 'budget_warning');
    }

    await budget.save({ session });
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
