import { Request, Response, NextFunction } from 'express';
import { TransactionService } from '../services/transactionService';
import { AuthRequest } from '../middleware/auth';
import { getPagination } from '../utils/pagination';
import { CSVUtils } from '../utils/csvUtils';
import fs from 'fs';
import path from 'path';

export class TransactionController {
  static async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const transaction = await TransactionService.createTransaction(req.user._id, req.body);
      res.status(201).json({
        success: true,
        data: transaction,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const pagination = getPagination(req.query);
      const filters = {
        type: req.query.type,
        category: req.query.category,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        search: req.query.search,
      };

      const result = await TransactionService.getTransactions(req.user._id, filters, pagination);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getOne(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const transaction = await TransactionService.getTransactionById(req.params.id, req.user._id);
      res.status(200).json({
        success: true,
        data: transaction,
      });
    } catch (err) {
      next(err);
    }
  }

  static async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const transaction = await TransactionService.updateTransaction(
        req.params.id,
        req.user._id,
        req.body,
      );
      res.status(200).json({
        success: true,
        data: transaction,
      });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await TransactionService.deleteTransaction(req.params.id, req.user._id);
      res.status(200).json({
        success: true,
        message: 'Transaction deleted successfully',
      });
    } catch (err) {
      next(err);
    }
  }

  static async bulkUpload(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const ext = path.extname(req.file.originalname).toLowerCase();
      let transactions: any[] = [];

      if (ext === '.json') {
        const content = fs.readFileSync(filePath, 'utf8');
        transactions = JSON.parse(content);
      } else if (ext === '.csv') {
        transactions = await CSVUtils.parseCSV(filePath);
      } else {
        return res.status(400).json({ success: false, message: 'Unsupported file format' });
      }

      // Pre-processing: convert strings to numbers
      const cleanedTransactions = transactions.map((t) => ({
        ...t,
        amount: Number(t.amount || t.Amount),
        date: t.date || t.Date ? new Date(t.date || t.Date) : new Date(),
        description: t.description || t.Description || 'Imported Transaction',
        type: (t.type || t.Type || 'expense').toLowerCase(),
        category: t.category || t.Category || 'Autres',
      }));

      const results = await TransactionService.bulkCreateTransactions(req.user._id, cleanedTransactions);

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      res.status(200).json({
        success: true,
        data: results,
      });
    } catch (err) {
      next(err);
    }
  }
}
