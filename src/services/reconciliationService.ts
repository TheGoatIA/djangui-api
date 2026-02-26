import User from '../models/User';
import Transaction from '../models/Transaction';
import { SlackService } from './slackService';
import logger from '../utils/logger';
import axios from 'axios';

export class ReconciliationService {
    /**
     * Vérifie si la somme des soldes Kauri correspond au solde réel sur NotchPay (Cameroun)
     */
    static async checkGlobalNotchPayBalance() {
        try {
            // 1. Somme des soldes Wallet pour les utilisateurs camerounais (XAF)
            const stats = await User.aggregate([
                { $match: { country: 'CM', isActive: true } },
                { $group: { _id: null, totalKauriXAF: { $sum: '$walletBalance' } } }
            ]);

            const totalKauriXAF = stats.length > 0 ? stats[0].totalKauriXAF : 0;

            // 2. Récupérer le solde réel via l'API NotchPay
            // Note: Ceci est une simulation de l'appel API NotchPay
            // En production: axios.get('https://api.notchpay.co/balance', { headers: { Authorization: process.env.NOTCHPAY_SECRET_KEY } })
            const notchPayBalanceXAF = await this.fetchNotchPayBalance();

            const diff = totalKauriXAF - notchPayBalanceXAF;

            // 3. Alerter si écart significatif (> 1000 XAF)
            if (Math.abs(diff) > 1000) {
                const message = `🚨 *DIFFERENCE DE RECONCILIATION DETECTEE (XAF)*\n` +
                    `Somme Wallets Kauri : ${totalKauriXAF.toLocaleString()} XAF\n` +
                    `Solde NotchPay Réel : ${notchPayBalanceXAF.toLocaleString()} XAF\n` +
                    `*Ecart : ${diff.toLocaleString()} XAF*`;

                await SlackService.sendNotification(message);
                logger.error(message);
            } else {
                logger.info(`Reconciliation XAF OK (Ecart: ${diff} XAF)`);
            }

            return { totalKauriXAF, notchPayBalanceXAF, diff };
        } catch (err: any) {
            logger.error(`Reconciliation Service Error: ${err.message}`);
            throw err;
        }
    }

    /**
     * Simulation de l'appel API NotchPay
     */
    private static async fetchNotchPayBalance(): Promise<number> {
        // Mock: En réel, extraire la balance XAF de la réponse API
        return 5000000; // Exemple: 5 millions XAF
    }
}
