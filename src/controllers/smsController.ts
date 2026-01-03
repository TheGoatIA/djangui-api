import { Request, Response, NextFunction } from 'express';
import { SmsParsingService } from '../services/smsParsingService';
import { TransactionService } from '../services/transactionService';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export class SMSController {
    /**
     * Parse a single SMS and create a transaction
     */
    static async parse(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { content } = req.body;
            if (!content) {
                throw new AppError('Contenu SMS requis', 400);
            }

            const parsed = await SmsParsingService.parseSMS(content);
            if (!parsed) {
                throw new AppError('Impossible de parser ce SMS', 422);
            }

            const transaction = await TransactionService.createTransaction(req.user._id, {
                ...parsed,
                isAutoCategorized: false, // Will be categorized by TransactionService
            });

            res.status(201).json({
                success: true,
                data: transaction,
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Bulk parse multiple SMS (useful if app syncs all messages)
     */
    static async bulkParse(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { messages } = req.body;
            if (!Array.isArray(messages)) {
                throw new AppError('Tableau de messages requis', 400);
            }

            const results = [];
            for (const content of messages) {
                try {
                    const parsed = await SmsParsingService.parseSMS(content);
                    if (parsed) {
                        const tx = await TransactionService.createTransaction(req.user._id, parsed);
                        results.push({ content, success: true, transaction: tx });
                    } else {
                        results.push({ content, success: false, reason: 'Parsing failed' });
                    }
                } catch (err: any) {
                    results.push({ content, success: false, reason: err.message });
                }
            }

            res.status(200).json({
                success: true,
                data: results,
            });
        } catch (err) {
            next(err);
        }
    }
}
