import { Response, NextFunction } from 'express';
import { CoachService } from '../services/ai/coachService';
import { AuthRequest } from '../middleware/auth';

export class CoachController {
    static async ask(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const { message } = req.body;
            if (!message) {
                return res.status(400).json({ success: false, message: 'Message is required' });
            }

            const response = await CoachService.askCoach(req.user._id, message);
            res.status(200).json({
                success: true,
                data: {
                    response,
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async getHistory(req: AuthRequest, res: Response, next: NextFunction) {
        try {
            const conversation = await CoachService.getOrCreateConversation(req.user._id);
            res.status(200).json({
                success: true,
                data: conversation,
            });
        } catch (err) {
            next(err);
        }
    }
}
