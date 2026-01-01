import { Request, Response, NextFunction } from 'express';
import { TransactionService } from '../services/transactionService';
import { AuthRequest } from '../middleware/auth';
import { getPagination } from '../utils/pagination';

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
}
