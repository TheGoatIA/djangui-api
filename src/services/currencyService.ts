import User from '../models/User';
import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import SavingGoal from '../models/SavingGoal';
import Investment from '../models/Investment';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

export class CurrencyService {
  /**
   * Fixed exchange rates for V1 launch.
   * Rates are relative to XAF (Base currency for initial development).
   * Example: 1 EUR = 655.957 XAF, 1 USD = ~600 XAF
   */
  private static readonly EXCHANGE_RATES: Record<string, number> = {
    XAF: 1,
    XOF: 1,
    FCFA: 1, // Alias for XAF/XOF
    EUR: 655.957,
    USD: 600,
    CAD: 450,
  };

  /**
   * Get exchange rate between two currencies
   */
  static getRate(from: string, to: string): number {
    const fromRate = this.EXCHANGE_RATES[from.toUpperCase()];
    const toRate = this.EXCHANGE_RATES[to.toUpperCase()];

    if (!fromRate || !toRate) {
      logger.error(`Exchange rate not found for ${from} or ${to}`);
      // Fallback to 1 if not found to prevent crashes, but ideally log/alert
      return 1;
    }

    // Calculation: from XAF -> to XAF
    // If from is EUR (655.957) and to is USD (600)
    // 1 EUR = 655.957 XAF
    // 655.957 XAF = (655.957 / 600) USD
    return fromRate / toRate;
  }

  /**
   * Massively convert all financial data for a user when country/currency changes
   */
  static async convertUserFinancialData(userId: string, oldCurrency: string, newCurrency: string) {
    if (oldCurrency === newCurrency) return;

    const rate = this.getRate(oldCurrency, newCurrency);
    logger.info(
      `Converting user ${userId} data from ${oldCurrency} to ${newCurrency} at rate ${rate}`,
    );

    try {
      // 1. Convert Wallet Balance in User model
      const user = await User.findById(userId);
      if (user) {
        user.walletBalance = Math.round(user.walletBalance * rate);
        user.monthlyIncome = Math.round(user.monthlyIncome * rate);
        user.currency = newCurrency;
        await (user as any).save({ validateBeforeSave: false });
      }

      // 2. Convert all Transactions
      const transactions = await Transaction.find({ userId });
      for (const tx of transactions) {
        tx.amount = Math.round(tx.amount * rate);
        await tx.save();
      }

      // 3. Convert all Budgets
      const budgets = await Budget.find({ userId });
      for (const budget of budgets) {
        budget.totalAllocated = Math.round(budget.totalAllocated * rate);
        budget.totalSpent = Math.round(budget.totalSpent * rate);
        for (const cat of budget.categories) {
          cat.allocated = Math.round(cat.allocated * rate);
          cat.spent = Math.round(cat.spent * rate);
        }
        await budget.save();
      }

      // 4. Convert all Saving Goals
      const goals = await SavingGoal.find({ userId });
      for (const goal of goals) {
        goal.targetAmount = Math.round(goal.targetAmount * rate);
        goal.currentAmount = Math.round(goal.currentAmount * rate);
        for (const cont of goal.contributions) {
          cont.amount = Math.round(cont.amount * rate);
        }
        await goal.save();
      }

      // 5. Convert all Investments
      const investments = await Investment.find({ userId });
      for (const inv of investments) {
        inv.initialAmount = Math.round(inv.initialAmount * rate);
        inv.currentValue = Math.round(inv.currentValue * rate);
        inv.currency = newCurrency;
        for (const hit of inv.history) {
          hit.value = Math.round(hit.value * rate);
        }
        await inv.save();
      }

      logger.info(`Successfully converted all data for user ${userId}`);
    } catch (error: any) {
      logger.error(`Massive conversion failed for user ${userId}: ${error.message}`);
      throw new AppError('Conversion financière échouée lors du changement de pays.', 500);
    }
  }
}
