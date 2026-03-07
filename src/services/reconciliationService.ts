import User from '../models/User';
import Transaction from '../models/Transaction';
import { SlackService } from './slackService';
import logger from '../utils/logger';

export class ReconciliationService {
  /**
   * Effectue un audit d'intégrité interne :
   * Vérifie si le solde affiché (walletBalance) correspond mathématiquement à l'historique des transactions.
   */
  static async checkInternalIntegrity() {
    try {
      logger.info(`[Reconciliation] Lancement de l'audit d'intégrité interne...`);

      const activeUsers = await User.find({ isActive: true });
      const anomalies: any[] = [];
      let totalChecked = 0;

      for (const user of activeUsers) {
        totalChecked++;

        // Calculer la balance théorique basée sur les transactions complétées
        const stats = await Transaction.aggregate([
          { $match: { userId: user._id, status: 'completed' } },
          {
            $group: {
              _id: '$type',
              total: { $sum: '$amount' },
              totalFees: { $sum: '$fees' },
            },
          },
        ]);

        let income = 0;
        let expense = 0;

        stats.forEach((s) => {
          // Entrées d'argent
          if (['deposit', 'tontine_payout', 'income', 'saving_transfer'].includes(s._id)) {
            income += s.total;
          }
          // Sorties d'argent (incluant les frais)
          else {
            expense += s.total + (s.totalFees || 0);
          }
        });

        const theoreticalBalance = income - expense;
        const diff = Math.abs(theoreticalBalance - user.walletBalance);

        // Seuil de tolérance (ex: 1 XAF pour arrondis)
        if (diff > 1) {
          anomalies.push({
            userId: user._id,
            email: user.email,
            currentBalance: user.walletBalance,
            theoreticalBalance,
            diff,
          });
        }
      }

      // 3. Alerter Slack si des anomalies sont détectées
      if (anomalies.length > 0) {
        const message =
          `🚨 *ANOMALIES DE RECONCILIATION INTERNE*\n` +
          `Utilisateurs audités : ${totalChecked}\n` +
          `Anomalies détectées : ${anomalies.length}\n` +
          `Détails : Rapport généré dans les logs admin.`;

        await SlackService.sendNotification(message);
        logger.error(message, { anomalies });
      } else {
        logger.info(`Réconciliation Interne OK : ${totalChecked} comptes vérifiés.`);
      }

      return {
        timestamp: new Date(),
        totalChecked,
        anomalyCount: anomalies.length,
        anomalies: anomalies.slice(0, 50), // On limite le retour pour l'UI
      };
    } catch (err: any) {
      logger.error(`Reconciliation Internal Audit Error: ${err.message}`);
      throw err;
    }
  }
}
