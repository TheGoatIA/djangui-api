import { SlackService } from './slackService';
import { WalletLedgerService } from './walletLedgerService';
import logger from '../utils/logger';

export class ReconciliationService {
  /**
   * Effectue un audit d'intégrité interne :
   * Vérifie si le solde affiché (walletBalance) correspond aux écritures du portefeuille.
   * Même règle que le contrôle quotidien (WalletLedgerService) : les saisies manuelles
   * du budget (espèces) et les achats payés directement chez l'opérateur sont ignorés.
   */
  static async checkInternalIntegrity() {
    try {
      logger.info(`[Reconciliation] Lancement de l'audit d'intégrité interne...`);

      const { totalChecked, anomalies: found } = await WalletLedgerService.findAnomalies();
      const anomalies = found.map((a) => ({
        userId: a.userId,
        email: a.email,
        currentBalance: a.walletBalance,
        theoreticalBalance: a.calculatedBalance,
        diff: a.diff,
      }));

      // Alerter Slack si des anomalies sont détectées
      if (anomalies.length > 0) {
        const message =
          `🚨 *ANOMALIES DE RECONCILIATION INTERNE*\n` +
          `Utilisateurs audités : ${totalChecked}\n` +
          `Anomalies détectées : ${anomalies.length}\n` +
          `Détails : Rapport généré dans les logs admin.`;

        await SlackService.sendFinance(message);
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
