import { Request, Response, NextFunction } from 'express';
import { EmailService } from '../services/emailService';
import { AppError } from '../middleware/errorHandler';

export class EmailController {
    static async sendAnyEmail(req: Request, res: Response, next: NextFunction) {
        try {
            const { to, subject, text, html } = req.body;

            if (!to || !subject || !text) {
                throw new AppError('To, Subject, and Text are required fields.', 400);
            }

            await EmailService.sendEmail(to, subject, text, html);

            res.status(200).json({
                success: true,
                message: `Email sent to ${to}`,
            });
        } catch (err) {
            next(err);
        }
    }
}
