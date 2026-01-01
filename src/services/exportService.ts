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
      const csv = parser.parse(transactions);

      return csv;
    } catch (error: any) {
      logger.error(`CSV Export error: ${error.message}`);
      throw error;
    }
  }
}
