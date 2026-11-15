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

  /**
   * Variante streaming : réponse en NDJSON (une ligne JSON par événement),
   * pas en JSON classique — le client lit le corps de la réponse au fil de
   * l'eau au lieu d'attendre la fin. Tant qu'aucun `res.write` n'a eu lieu,
   * une erreur passe encore par `next(err)` (code HTTP correct : 403/429/503
   * selon le cas) ; une fois le flux commencé, les en-têtes sont déjà partis
   * et l'erreur est alors envoyée comme une ligne NDJSON supplémentaire.
   */
  static async askStream(req: AuthRequest, res: Response, next: NextFunction) {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      const result = await CoachService.askCoachStream(req.user._id, message, (delta) => {
        res.write(`${JSON.stringify({ delta })}\n`);
      });
      res.write(`${JSON.stringify({ done: true, actions: result.actions })}\n`);
      res.end();
    } catch (err: any) {
      if (res.headersSent) {
        res.write(
          `${JSON.stringify({ error: err.message || 'AI Service currently unavailable' })}\n`,
        );
        res.end();
      } else {
        next(err);
      }
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
