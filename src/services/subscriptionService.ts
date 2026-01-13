import Subscription, { ISubscriptionDocument } from '../models/Subscription';
import Transaction from '../models/Transaction';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import { ISubscription } from '../types/models';
import logger from '../utils/logger';

export class SubscriptionService {
    /**
     * Créer un nouvel abonnement
     */
    static async createSubscription(userId: string, data: Partial<ISubscription>): Promise<ISubscriptionDocument> {
        const user = await User.findById(userId);
        if (!user) throw new AppError('Utilisateur non trouvé', 404);

        const subscription = await Subscription.create({
            ...data,
            userId,
        });

        logger.info(`Subscription created: ${subscription.name} for user ${userId}`);
        return subscription;
    }

    /**
     * Récupérer les abonnements d'un utilisateur
     */
    static async getUserSubscriptions(userId: string): Promise<ISubscriptionDocument[]> {
        return await Subscription.find({ userId }).sort({ nextBillingDate: 1 });
    }

    /**
     * Récupérer un abonnement par ID
     */
    static async getSubscriptionById(id: string, userId: string): Promise<ISubscriptionDocument> {
        const subscription = await Subscription.findOne({ _id: id, userId });
        if (!subscription) throw new AppError('Abonnement non trouvé', 404);
        return subscription;
    }

    /**
     * Mettre à jour un abonnement
     */
    static async updateSubscription(id: string, userId: string, data: Partial<ISubscription>): Promise<ISubscriptionDocument> {
        const subscription = await Subscription.findOneAndUpdate(
            { _id: id, userId },
            { $set: data },
            { new: true, runValidators: true }
        );

        if (!subscription) throw new AppError('Abonnement non trouvé', 404);
        return subscription;
    }

    /**
     * Supprimer un abonnement
     */
    static async deleteSubscription(id: string, userId: string): Promise<void> {
        const result = await Subscription.deleteOne({ _id: id, userId });
        if (result.deletedCount === 0) throw new AppError('Abonnement non trouvé', 404);
    }

    /**
     * Détecter les abonnements suggérés basés sur l'historique des transactions
     * Algorithme simple : cherche les transactions de même montant/marchand à intervalles réguliers
     */
    static async detectSubscriptions(userId: string): Promise<any[]> {
        const transactions = await Transaction.find({ userId, type: 'expense' })
            .sort({ date: -1 })
            .limit(200);

        const groups: { [key: string]: any[] } = {};

        // Grouper par marchand et montant
        transactions.forEach(t => {
            const key = `${t.merchant || t.description.split(' ')[0]}_${t.amount}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(t);
        });

        const suggestions = [];
        for (const key in groups) {
            const group = groups[key];
            if (group.length >= 2) {
                // Vérifier la régularité (approximativement 30 jours)
                const dates = group.map(t => new Date(t.date).getTime()).sort((a, b) => b - a);
                const diffs = [];
                for (let i = 0; i < dates.length - 1; i++) {
                    diffs.push((dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
                }

                const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;

                // Si la différence est proche de 7, 14 ou 30 jours
                let frequency: 'weekly' | 'monthly' | 'yearly' | null = null;
                if (avgDiff >= 25 && avgDiff <= 35) frequency = 'monthly';
                else if (avgDiff >= 5 && avgDiff <= 9) frequency = 'weekly';
                else if (avgDiff >= 360 && avgDiff <= 370) frequency = 'yearly';

                if (frequency) {
                    suggestions.push({
                        name: group[0].merchant || group[0].description,
                        amount: group[0].amount,
                        frequency,
                        confidence: group.length >= 3 ? 0.9 : 0.7,
                        detectedFrom: group.length,
                        category: group[0].category
                    });
                }
            }
        }

        return suggestions;
    }
}
