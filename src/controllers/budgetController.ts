import { Request, Response, NextFunction } from 'express';
import { BudgetService } from '../services/budgetService';
import { AuthRequest } from '../middleware/auth';

export class BudgetController {
    static async create(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const budget = await BudgetService.createBudget(req.user._id, req.body);
            res.status(201).json({
                success: true,
                data: budget,
            });
        } catch (err) {
            next(err);
        }
    }

    static async getCurrent(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const budget = await BudgetService.getCurrentBudget(req.user._id);
            res.status(200).json({
                success: true,
                data: budget,
            });
        } catch (err) {
            next(err);
        }
    }

    static async getAll(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const filters = {
                year: req.query.year,
                month: req.query.month,
            };
            const budgets = await BudgetService.getBudgets(req.user._id, filters);
            res.status(200).json({
                success: true,
                data: budgets,
            });
        } catch (err) {
            next(err);
        }
    }

    static async update(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const budget = await BudgetService.updateBudget(req.params.id, req.user._id, req.body);
            res.status(200).json({
                success: true,
                data: budget,
            });
        } catch (err) {
            next(err);
        }
    }
}
