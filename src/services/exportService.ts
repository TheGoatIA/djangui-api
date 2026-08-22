import Transaction from '../models/Transaction';
import { Parser } from 'json2csv';
import logger from '../utils/logger';

export class ExportService {
  /**
   * Export transactions to CSV
   */
  static async exportTransactionsToCSV(userId: string, filters: any = {}) {
    try {
      const query: any = { userId };
      if (filters.startDate || filters.endDate) {
        query.date = {};
        if (filters.startDate) query.date.$gte = new Date(filters.startDate);
        if (filters.endDate) query.date.$lte = new Date(filters.endDate);
      }

      const transactions = await Transaction.find(query).sort({ date: -1 }).lean();

      if (transactions.length === 0) {
        return null;
      }

      // CSV/Excel formula injection defense: description/merchant/category can
      // contain free-text (user-entered or SMS-parsed) content. A cell starting
      // with =, +, -, or @ is interpreted as a formula by Excel/Sheets when the
      // export is opened — prefixing with a single quote neutralizes it while
      // leaving the value readable.
      const neutralizeFormula = (value: any) => {
        if (typeof value !== 'string') return value;
        return /^[=+\-@]/.test(value) ? `'${value}` : value;
      };
      const sanitized = transactions.map((t: any) => ({
        ...t,
        description: neutralizeFormula(t.description),
        merchant: neutralizeFormula(t.merchant),
        category: neutralizeFormula(t.category),
        subcategory: neutralizeFormula(t.subcategory),
      }));

      const fields = [
        'date',
        'type',
        'category',
        'subcategory',
        'description',
        'amount',
        'merchant',
        'isRecurring',
      ];
      const opts = { fields };
      const parser = new Parser(opts);
      const csv = parser.parse(sanitized);

      return csv;
    } catch (error: any) {
      logger.error(`CSV Export error: ${error.message}`);
      throw error;
    }
  }
}
