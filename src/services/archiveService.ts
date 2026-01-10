import Transaction from '../models/Transaction';
import ArchivedTransaction from '../models/ArchivedTransaction';
import logger from '../utils/logger';
import mongoose from 'mongoose';

export class ArchiveService {
  /**
   * Archive transactions older than 2 years
   */
  static async runArchiving() {
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    try {
      logger.info(`Starting data archiving for records older than ${twoYearsAgo.toISOString()}...`);

      // 1. Find transactions to archive
      const oldTransactions = await Transaction.find({
        date: { $lt: twoYearsAgo },
      });

      if (oldTransactions.length === 0) {
        logger.info('No old transactions found to archive.');
        return;
      }

      logger.info(`Found ${oldTransactions.length} transactions to archive.`);

      // 2. Prepare data for insertion (strip Mongoose specifics but keep data)
      const archiveData = oldTransactions.map((t) => {
        const obj = t.toObject();
        delete (obj as any)._id;
        delete (obj as any).createdAt;
        delete (obj as any).updatedAt;
        delete (obj as any).__v;
        return {
          ...obj,
          archivedAt: new Date(),
        };
      });

      // 3. Batch insert into ArchivedTransaction
      await ArchivedTransaction.insertMany(archiveData);
      logger.info(`Successfully copied ${oldTransactions.length} transactions to archive.`);

      // 4. Delete from main Transaction collection
      const idsToDelete = oldTransactions.map((t) => t._id);
      await Transaction.deleteMany({ _id: { $in: idsToDelete } });
      logger.info(`Successfully deleted archived transactions from main collection.`);

      // 5. Optionally: Run compaction on the collection (requires admin rights, usually done by MongoDB background)
      // Transaction.collection.conn.db.command({ compact: 'transactions' });
    } catch (error: any) {
      logger.error(`Error during data archiving: ${error.message}`);
      throw error;
    }
  }
}
