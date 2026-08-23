import mongoose from 'mongoose';
import logger from '../utils/logger';
import User from '../models/User';
import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import SavingGoal from '../models/SavingGoal';
import Investment from '../models/Investment';

export class CurrencyService {
  // Base currency is XAF
  private static readonly exchangeRates: Record<string, number> = {
    XAF: 1,
    XOF: 1, // Fixed parity
    EUR: 655.957, // Fixed parity
    CAD: 450, // Approximate
    USD: 610, // Approximate
  };

  // Update this date whenever `exchangeRates` above is revised. XAF/XOF/EUR
  // are real fixed pegs and never go stale; USD/CAD are hand-set approximations
  // that drift from the real market rate over time, which matters here because
  // they're used for real conversions (wallet rebasing on country change,
  // tontine contribution amounts) — see `checkRatesStaleness`.
  private static readonly ratesLastReviewedAt = new Date('2026-04-16');

  private static readonly symbols: Record<string, string> = {
    XAF: 'FCFA',
    XOF: 'FCFA',
    EUR: '€',
    CAD: '$',
    USD: '$',
  };

  /**
   * Returns a copy of the currency -> XAF rate table, for callers that need
   * to build their own conversion (e.g. a MongoDB aggregation $switch) rather
   * than convert one amount at a time in Node.
   */
  static getRatesToXAF(): Record<string, number> {
    return { ...this.exchangeRates };
  }

  /**
   * Returns the exchange rate from source to target currency
   */
  static getRate(from: string, to: string): number {
    if (from === to) return 1;
    const rateFrom = this.exchangeRates[from] || 1;
    const rateTo = this.exchangeRates[to] || 1;
    return rateFrom / rateTo;
  }

  /**
   * Converts an amount from one currency to another
   */
  static convert(amount: number, from: string = 'XAF', to: string = 'XAF'): number {
    if (from === to) return amount;

    // First convert to base (XAF)
    const rateFrom = this.exchangeRates[from] || 1;
    const amountInXaf = amount * rateFrom;

    // Then convert to target
    const rateTo = this.exchangeRates[to] || 1;
    const convertedAmount = amountInXaf / rateTo;

    return Math.round(convertedAmount * 100) / 100;
  }

  /**
   * Finds amounts in text and converts them
   * Example: "Économise 50000FCFA" -> "Économise 111.11$" if target is CAD
   */
  static convertText(text: string, targetCurrency: string, sourceCurrency: string = 'XAF'): string {
    if (!text || targetCurrency === sourceCurrency) return text;

    // Regex to find patterns like "50000 FCFA", "50 000FCFA", "50000F", etc.
    // Also captures just numbers if they are followed by common indicators or just in context
    const currencySuffixes = ['FCFA', 'XAF', 'XOF', 'F', 'CFA'];
    const suffixRegex = currencySuffixes.join('|');

    const regex = new RegExp(`(\\d+[\\d\\s.,]*)\\s*(${suffixRegex})`, 'gi');

    return text.replace(regex, (match, amountStr, suffix) => {
      // Clean amount string (remove spaces)
      const cleanAmountStr = amountStr.replace(/\s/g, '').replace(',', '.');
      const amount = parseFloat(cleanAmountStr);

      if (isNaN(amount)) return match;

      const converted = this.convert(amount, sourceCurrency, targetCurrency);
      const symbol = this.symbols[targetCurrency] || targetCurrency;

      // format: 123.45 $ or 123.45 €
      return `${converted.toLocaleString()}${symbol}`;
    });
  }

  static getSymbol(currency: string): string {
    return this.symbols[currency] || currency;
  }

  /**
   * Logs a warning if the hand-set exchange rates (USD/CAD) haven't been
   * reviewed in `maxAgeDays`. These aren't fixed pegs like XOF/EUR, so left
   * unchecked they silently drift from the real market rate while still being
   * used to convert real money (wallet balances, tontine contributions).
   * Called daily from CronService; not a substitute for a live FX feed, but
   * ensures staleness is at least visible instead of silent.
   */
  static checkRatesStaleness(maxAgeDays = 30): void {
    const ageDays = (Date.now() - this.ratesLastReviewedAt.getTime()) / (24 * 3600 * 1000);
    if (ageDays > maxAgeDays) {
      logger.warn(
        `[CurrencyService] Les taux de change approximatifs (USD, CAD) n'ont pas été révisés depuis ${Math.floor(
          ageDays,
        )} jours (dernière révision : ${this.ratesLastReviewedAt.toISOString().split('T')[0]}). Vérifier leur exactitude par rapport au marché.`,
      );
    }
  }

  /**
   * Converts all financial data for a user when their currency changes
   * (approved country change). Runs inside a single Mongo session so a
   * partial conversion (e.g. transactions converted but goals left in the
   * old currency) can never happen. Uses aggregation-pipeline updates
   * ($round/$multiply) so amounts are converted server-side without
   * loading every document into memory.
   */
  static async convertUserFinancialData(
    userId: string,
    oldCurrency: string,
    newCurrency: string,
  ): Promise<void> {
    if (oldCurrency === newCurrency) return;

    const rate = this.getRate(oldCurrency, newCurrency);
    logger.info(
      `Converting financial data for user ${userId} from ${oldCurrency} to ${newCurrency} at rate ${rate}`,
    );

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      await Transaction.updateMany(
        { userId: userObjectId },
        [
          {
            $set: {
              amount: { $round: [{ $multiply: ['$amount', rate] }, 2] },
              fees: { $round: [{ $multiply: [{ $ifNull: ['$fees', 0] }, rate] }, 2] },
              currency: newCurrency,
            },
          },
        ],
        { session },
      );

      await Budget.updateMany(
        { userId: userObjectId },
        [
          {
            $set: {
              totalAllocated: { $round: [{ $multiply: ['$totalAllocated', rate] }, 2] },
              totalSpent: { $round: [{ $multiply: ['$totalSpent', rate] }, 2] },
              currency: newCurrency,
              categories: {
                $map: {
                  input: '$categories',
                  as: 'c',
                  in: {
                    _id: '$$c._id',
                    name: '$$c.name',
                    allocated: { $round: [{ $multiply: ['$$c.allocated', rate] }, 2] },
                    spent: { $round: [{ $multiply: ['$$c.spent', rate] }, 2] },
                    percentage: '$$c.percentage',
                  },
                },
              },
            },
          },
        ],
        { session },
      );

      await SavingGoal.updateMany(
        { userId: userObjectId },
        [
          {
            $set: {
              targetAmount: { $round: [{ $multiply: ['$targetAmount', rate] }, 2] },
              currentAmount: { $round: [{ $multiply: ['$currentAmount', rate] }, 2] },
              currency: newCurrency,
              contributions: {
                $map: {
                  input: '$contributions',
                  as: 'c',
                  in: {
                    _id: '$$c._id',
                    amount: { $round: [{ $multiply: ['$$c.amount', rate] }, 2] },
                    date: '$$c.date',
                    note: '$$c.note',
                  },
                },
              },
            },
          },
        ],
        { session },
      );

      await Investment.updateMany(
        { userId: userObjectId },
        [
          {
            $set: {
              initialAmount: { $round: [{ $multiply: ['$initialAmount', rate] }, 2] },
              currentValue: { $round: [{ $multiply: ['$currentValue', rate] }, 2] },
              currency: newCurrency,
              history: {
                $map: {
                  input: '$history',
                  as: 'h',
                  in: {
                    _id: '$$h._id',
                    value: { $round: [{ $multiply: ['$$h.value', rate] }, 2] },
                    date: '$$h.date',
                  },
                },
              },
            },
          },
        ],
        { session },
      );

      await User.updateOne(
        { _id: userObjectId },
        [{ $set: { walletBalance: { $round: [{ $multiply: ['$walletBalance', rate] }, 2] } } }],
        { session },
      );

      await session.commitTransaction();
      logger.info(`Financial data conversion completed for user ${userId}`);
    } catch (error: any) {
      await session.abortTransaction();
      logger.error(`Financial data conversion FAILED for user ${userId}: ${error.message}`);
      throw error;
    } finally {
      session.endSession();
    }
  }
}
