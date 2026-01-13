import { Request, Response, NextFunction } from 'express';
import { SubscriptionService } from '../services/subscriptionService';

export class SubscriptionController {
    /**
     * Créer un abonnement
     */
    static async create(req: Request, res: Response, next: NextFunction) {
        try {
            const subscription = await SubscriptionService.createSubscription((req as any).user.id, req.body);
            res.status(201).json({ status: 'success', data: subscription });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Lister les abonnements
     */
    static async list(req: Request, res: Response, next: NextFunction) {
        try {
            const subscriptions = await SubscriptionService.getUserSubscriptions((req as any).user.id);
            res.json({ status: 'success', data: subscriptions });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Détails d'un abonnement
     */
    static async getDetails(req: Request, res: Response, next: NextFunction) {
        try {
            const subscription = await SubscriptionService.getSubscriptionById(req.params.id, (req as any).user.id);
            res.json({ status: 'success', data: subscription });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Mettre à jour un abonnement
     */
    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const subscription = await SubscriptionService.updateSubscription(req.params.id, (req as any).user.id, req.body);
            res.json({ status: 'success', data: subscription });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Supprimer un abonnement
     */
    static async delete(req: Request, res: Response, next: NextFunction) {
        try {
            await SubscriptionService.deleteSubscription(req.params.id, (req as any).user.id);
            res.json({ status: 'success', message: 'Abonnement supprimé avec succès' });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Détecter les abonnements suggérés
     */
    static async detect(req: Request, res: Response, next: NextFunction) {
        try {
            const suggestions = await SubscriptionService.detectSubscriptions((req as any).user.id);
            res.json({ status: 'success', data: suggestions });
        } catch (error) {
            next(error);
        }
    }
}

export default SubscriptionController;
