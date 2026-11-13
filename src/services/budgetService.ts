import crypto from 'crypto';
import mongoose from 'mongoose';
import Budget from '../models/Budget';
import BudgetParticipant from '../models/BudgetParticipant';
import SavingGoal from '../models/SavingGoal';
import User from '../models/User';
import Transaction from '../models/Transaction';
import { AppError } from '../middleware/errorHandler';

/**
 * Normalises client categories: names trimmed and unique (case-insensitive),
 * `spent` NEVER taken from the client — it only grows through real expenses
 * (TransactionService.applyExpenseToBudget).
 */
function cleanCategories(categories: any[]): { name: string; allocated: number }[] {
  const seen = new Set<string>();
  return (categories || []).map((c) => {
    const name = String(c.name).trim();
    const key = name.toLowerCase();
    if (!name) throw new AppError('Nom de catégorie vide', 400);
    if (seen.has(key)) throw new AppError(`Catégorie en double : ${name}`, 400);
    seen.add(key);
    return { name, allocated: Number(c.allocated) };
  });
}

const sumAllocated = (cats: { allocated: number }[]) =>
  Math.round(cats.reduce((s, c) => s + c.allocated, 0) * 100) / 100;

export class BudgetService {
  static async createBudget(userId: string, rawData: any) {
    const categories = cleanCategories(rawData.categories);
    const data = {
      period: rawData.period,
      categories,
      // Derived server-side (the app sends the same sum): a client total could
      // otherwise disagree with its own categories.
      totalAllocated: sumAllocated(categories),
      linkedGoalId: rawData.linkedGoalId,
    };
    const existingBudget = await Budget.findOne({
      userId,
      'period.month': data.period.month,
      'period.year': data.period.year,
    });

    if (existingBudget) {
      throw new AppError('Budget for this period already exists', 400);
    }

    if (data.linkedGoalId) {
      await BudgetService.assertOwnGoal(userId, data.linkedGoalId);
    }

    // Always the creating user's own currency, never a client-supplied value —
    // this is what lets currencyMiddleware tell the amounts below are already
    // native to that currency instead of assuming XAF.
    const user = await User.findById(userId).select('currency').lean();

    // Dépenses DÉJÀ faites sur la période : un budget créé en milieu de mois
    // démarrait à 0 « dépensé » (seules les dépenses ultérieures étaient
    // comptées) et affichait une marge fausse — constaté en E2E mobile (9 000
    // dépensés en Alimentation, budget créé ensuite : « Dépensé : 0 »).
    // Même règle de correspondance que applyExpenseToBudget (nom de catégorie,
    // insensible à la casse).
    const month = Number(data.period?.month);
    const year = Number(data.period?.year);
    let categoriesWithSpent: any[] = categories.map((c) => ({ ...c, spent: 0 }));
    let totalSpent = 0;
    let status: 'active' | 'exceeded' = 'active';
    if (month >= 1 && month <= 12 && year > 2000) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 1);
      const spentByCategory = await Transaction.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(String(userId)),
            type: 'expense',
            date: { $gte: start, $lt: end },
          },
        },
        { $group: { _id: { $toLower: '$category' }, amount: { $sum: '$amount' } } },
      ]);
      const byName = new Map(
        spentByCategory.map((r: any) => [String(r._id), Number(r.amount) || 0]),
      );
      categoriesWithSpent = categories.map((c) => {
        const spent = Math.round((byName.get(c.name.toLowerCase()) || 0) * 100) / 100;
        if (c.allocated > 0 && spent >= c.allocated) status = 'exceeded';
        return { ...c, spent };
      });
      totalSpent = Math.round(categoriesWithSpent.reduce((sum, c) => sum + c.spent, 0) * 100) / 100;
    }

    const budget = await Budget.create({
      ...data,
      categories: categoriesWithSpent,
      totalSpent,
      status,
      userId,
      currency: user?.currency || 'XAF',
    });
    return budget;
  }

  /**
   * Vérifie que `goalId` existe et appartient bien à `userId` avant de le lier
   * à un budget — sans ça, un budget pourrait pointer vers l'objectif d'un
   * autre utilisateur.
   */
  private static async assertOwnGoal(userId: string, goalId: string): Promise<void> {
    const goal = await SavingGoal.findOne({ _id: goalId, userId }).select('_id').lean();
    if (!goal) throw new AppError('Objectif introuvable', 404);
  }

  /**
   * IDs (budgets possédés + budgets partagés où l'utilisateur est participant
   * actif) — factorisé car réutilisé par getCurrentBudget/getBudgets/
   * getRemainingAcrossBudgets.
   */
  private static async getAccessibleBudgetFilter(userId: string) {
    const participations = await BudgetParticipant.find({
      userId,
      invitationStatus: 'accepted',
    })
      .select('budgetId')
      .lean();
    const sharedBudgetIds = participations.map((p) => p.budgetId);
    return { $or: [{ userId }, { _id: { $in: sharedBudgetIds } }] };
  }

  private static withOwnerFlag(budget: any, userId: string) {
    return { ...budget, isOwner: budget.userId?.toString() === userId.toString() };
  }

  static async getCurrentBudget(userId: string) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const accessibleFilter = await BudgetService.getAccessibleBudgetFilter(userId);
    const budget = await Budget.findOne({
      ...accessibleFilter,
      'period.month': month,
      'period.year': year,
    }).lean();

    return budget ? BudgetService.withOwnerFlag(budget, userId) : null;
  }

  static async getBudgets(userId: string, filters: any) {
    const accessibleFilter = await BudgetService.getAccessibleBudgetFilter(userId);
    const query: any = { ...accessibleFilter };
    if (filters.year) query['period.year'] = parseInt(filters.year);
    if (filters.month) query['period.month'] = parseInt(filters.month);

    const budgets = await Budget.find(query).sort({ 'period.year': -1, 'period.month': -1 }).lean();
    return budgets.map((b) => BudgetService.withOwnerFlag(b, userId));
  }

  static async updateBudget(id: string, userId: string, data: any) {
    if (data.linkedGoalId) {
      await BudgetService.assertOwnGoal(userId, data.linkedGoalId);
    }

    // Le filtre {_id, userId} restreint la mise à jour au seul propriétaire.
    const budget = await Budget.findOne({ _id: id, userId });
    if (!budget) {
      throw new AppError('Budget not found', 404);
    }

    if (data.categories) {
      // `$set: { categories }` replaced the array with {name, allocated} only:
      // every category's recorded `spent` silently went back to 0. Spending is
      // now carried over by name.
      const previous = new Map(
        (budget.categories || []).map((c: any) => [String(c.name).toLowerCase(), c.spent || 0]),
      );
      const categories = cleanCategories(data.categories).map((c) => ({
        ...c,
        spent: previous.get(c.name.toLowerCase()) || 0,
      }));
      budget.categories = categories as any;
      budget.totalAllocated = sumAllocated(categories);
    }
    if (data.status !== undefined) budget.status = data.status;
    if (data.linkedGoalId !== undefined) budget.linkedGoalId = data.linkedGoalId;
    // totalSpent is untouched: removing a category does not erase money spent.

    await budget.save();
    return budget;
  }

  static async deleteBudget(id: string, userId: string) {
    const budget = await Budget.findOneAndDelete({ _id: id, userId });

    if (!budget) {
      throw new AppError('Budget not found', 404);
    }

    // Nettoyage des participants — un budget supprimé ne doit laisser aucune
    // référence orpheline dans BudgetParticipant.
    await BudgetParticipant.deleteMany({ budgetId: id });

    return true;
  }

  // ─── PARTAGE ────────────────────────────────────────────────────────────

  static async shareBudget(budgetId: string, ownerId: string) {
    const budget = await Budget.findOne({ _id: budgetId, userId: ownerId });
    if (!budget) throw new AppError('Budget non trouvé ou non autorisé', 404);

    if (!budget.inviteCode) {
      // CSPRNG (pas Math.random) — même exigence qu'un code d'accès, voir
      // le même choix déjà fait sur Tontine.inviteCode.
      budget.inviteCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    }
    budget.isShared = true;
    await budget.save();

    return { inviteCode: budget.inviteCode! };
  }

  static async joinBudget(userId: string, displayName: string, inviteCode: string) {
    const budget = await Budget.findOne({ inviteCode: inviteCode.toUpperCase(), isShared: true });
    if (!budget) throw new AppError("Code d'invitation invalide", 404);

    if (budget.userId.toString() === userId.toString()) {
      throw new AppError('Vous êtes déjà le propriétaire de ce budget', 400);
    }

    const existing = await BudgetParticipant.findOne({ budgetId: budget._id, userId });
    if (existing) {
      if (existing.invitationStatus === 'removed') {
        existing.invitationStatus = 'accepted';
        existing.joinedAt = new Date();
        await existing.save();
        return budget;
      }
      throw new AppError('Vous participez déjà à ce budget', 400);
    }

    await BudgetParticipant.create({
      budgetId: budget._id,
      userId,
      displayName,
      invitationStatus: 'accepted',
    });

    return budget;
  }

  static async getParticipants(budgetId: string, requesterId: string) {
    const budget = await Budget.findById(budgetId).select('userId').lean();
    if (!budget) throw new AppError('Budget non trouvé', 404);

    const isOwner = budget.userId.toString() === requesterId.toString();
    if (!isOwner) {
      const isParticipant = await BudgetParticipant.exists({
        budgetId,
        userId: requesterId,
        invitationStatus: 'accepted',
      });
      if (!isParticipant) throw new AppError('Accès non autorisé', 403);
    }

    return BudgetParticipant.find({ budgetId, invitationStatus: 'accepted' })
      .sort({ joinedAt: 1 })
      .lean();
  }

  static async removeParticipant(budgetId: string, ownerId: string, participantId: string) {
    const budget = await Budget.findOne({ _id: budgetId, userId: ownerId }).select('_id').lean();
    if (!budget) throw new AppError('Budget non trouvé ou non autorisé', 404);

    const participant = await BudgetParticipant.findOneAndUpdate(
      { _id: participantId, budgetId },
      { invitationStatus: 'removed' },
      { new: true },
    );
    if (!participant) throw new AppError('Participant non trouvé', 404);

    return true;
  }

  static async leaveBudget(budgetId: string, userId: string) {
    const participant = await BudgetParticipant.findOneAndUpdate(
      { budgetId, userId, invitationStatus: 'accepted' },
      { invitationStatus: 'removed' },
      { new: true },
    );
    if (!participant) throw new AppError('Vous ne participez pas à ce budget', 404);

    return true;
  }

  // ─── AGRÉGATS ───────────────────────────────────────────────────────────

  /**
   * Somme (allocated - spent) du budget propre + de tous les budgets partagés
   * où l'utilisateur est participant actif, pour la période donnée — alimente
   * le "reste à vivre" du dashboard.
   */
  static async getRemainingAcrossBudgets(
    userId: string,
    month: number,
    year: number,
  ): Promise<{ amount: number; currency: string } | null> {
    const accessibleFilter = await BudgetService.getAccessibleBudgetFilter(userId);
    const budgets = await Budget.find({
      ...accessibleFilter,
      'period.month': month,
      'period.year': year,
    })
      .select('totalAllocated totalSpent currency')
      .lean();

    if (budgets.length === 0) return null;

    const amount = budgets.reduce((sum, b) => sum + (b.totalAllocated - b.totalSpent), 0);
    return { amount, currency: budgets[0].currency || 'XAF' };
  }

  /**
   * Historique d'une catégorie sur les N derniers budgets (mois) de
   * l'utilisateur — pour le graphique d'évolution des dépenses.
   */
  static async getCategoryHistory(userId: string, category: string, months: number) {
    const budgets = await Budget.find({ userId, 'period.type': 'monthly' })
      .sort({ 'period.year': -1, 'period.month': -1 })
      .limit(months)
      .select('period categories')
      .lean();

    return budgets
      .map((b) => {
        const cat = b.categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
        return {
          month: b.period.month,
          year: b.period.year,
          allocated: cat?.allocated ?? 0,
          spent: cat?.spent ?? 0,
        };
      })
      .reverse(); // chronologique (plus ancien -> plus récent)
  }
}
