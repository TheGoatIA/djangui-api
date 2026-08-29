import Transaction from '../models/Transaction';
import Payment from '../models/Payment';
import logger from '../utils/logger';
import { SlackService } from './slackService';
import { MonitoringService } from './monitoringService';

export interface FraudAssessment {
  score: number; // 0 to 100
  isSuspicious: boolean;
  block: boolean;
  reasons: string[];
}

export class FraudService {
  /**
   * Évalue le niveau de risque d'une transaction financière, d'un retrait ou
   * d'un dépôt. Règles heuristiques :
   * 1. Vélocité : > 5 transactions dans les 10 dernières minutes (+35 score)
   * 2. Retraits consécutifs rapprochés (+25 score)
   * 3. Montant atypique : retrait > 5x la moyenne historique de l'utilisateur (+30 score)
   * 4. Dépôts consécutifs rapprochés (+25 score) — signal classique de
   *    card-testing / structuration de dépôts pour rester sous les plafonds AML
   * 5. Score >= 70 : Blocage automatique et alerte Slack
   */
  static async assess(
    userId: string,
    amount: number,
    type: string,
    currency: string = 'XAF',
  ): Promise<FraudAssessment> {
    let score = 0;
    const reasons: string[] = [];
    const triggeredRules: string[] = [];

    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Règle 1 : Vélocité récente
      const recentTxCount = await Transaction.countDocuments({
        userId,
        createdAt: { $gte: tenMinutesAgo },
      });

      if (recentTxCount >= 5) {
        score += 35;
        reasons.push(
          `Vélocité élevée: ${recentTxCount} transactions dans les 10 dernières minutes`,
        );
        triggeredRules.push('velocity');
      }

      // Règle 2 : Retraits rapprochés
      if (type === 'withdrawal') {
        const recentWithdrawals = await Transaction.countDocuments({
          userId,
          category: 'withdrawal',
          createdAt: { $gte: oneHourAgo },
        });

        if (recentWithdrawals >= 3) {
          score += 25;
          reasons.push(
            `Multiples retraits rapprochés: ${recentWithdrawals} retraits dans la dernière heure`,
          );
          triggeredRules.push('rapid_withdrawals');
        }
      }

      // Règle 3 : Déviation par rapport à la moyenne historique des retraits
      if (type === 'withdrawal' && amount > 0) {
        const historyStats = await Transaction.aggregate([
          { $match: { userId, category: 'withdrawal', status: 'completed' } },
          { $group: { _id: null, avgAmount: { $avg: '$amount' }, count: { $sum: 1 } } },
        ]);

        if (historyStats.length > 0 && historyStats[0].count >= 3) {
          const avg = historyStats[0].avgAmount;
          if (amount >= avg * 5 && amount > 100_000) {
            score += 30;
            reasons.push(
              `Montant atypique: ${amount} ${currency} dépasse 5x la moyenne (${Math.round(avg)} ${currency})`,
            );
            triggeredRules.push('amount_deviation');
          }
        }
      }

      // Règle 4 : Dépôts consécutifs rapprochés — les dépôts n'avaient
      // auparavant aucune évaluation anti-fraude (contrairement aux retraits),
      // laissant un utilisateur déposer sans limite de fréquence, un schéma
      // classique de card-testing ou de structuration sous les plafonds AML.
      // On compte les INITIATIONS de paiement (Payment), pas les Transaction
      // (qui ne sont créées qu'après confirmation par webhook) — sinon on ne
      // détecterait jamais une rafale de tentatives échouées/abandonnées,
      // pourtant le signal le plus caractéristique du card-testing.
      if (type === 'deposit') {
        const recentDepositAttempts = await Payment.countDocuments({
          userId,
          type: 'deposit',
          createdAt: { $gte: oneHourAgo },
        });

        if (recentDepositAttempts >= 5) {
          score += 25;
          reasons.push(
            `Multiples tentatives de dépôt rapprochées: ${recentDepositAttempts} dans la dernière heure`,
          );
          triggeredRules.push('rapid_deposits');
        }
      }

      const isSuspicious = score >= 50;
      const block = score >= 70;

      if (isSuspicious) {
        logger.warn(
          `[FRAUD] Transaction suspecte détectée pour user ${userId}. Score: ${score}/100. Raisons: ${reasons.join(', ')}`,
        );

        const severity: 'high' | 'critical' = block ? 'critical' : 'high';
        const actionTaken = block ? 'blocked' : 'flagged';
        for (const rule of triggeredRules) {
          MonitoringService.recordSuspiciousActivity(rule, severity, actionTaken);
          MonitoringService.recordFraudAlert(rule, severity);
        }

        // A score of 50-69 previously produced only this log line — invisible
        // to anyone not actively tailing logs. It still gets a Slack alert now,
        // just a non-critical one, so a human actually sees it instead of it
        // being lost among thousands of other log lines.
        const reasonList = reasons.map((r) => `  - ${r}`).join('\n');
        const message = block
          ? `🚨 *ALERTE FRAUDE BLOQUANTE*\n*Utilisateur*: \`${userId}\`\n*Score Fraude*: *${score}/100*\n*Montant*: ${amount} ${currency} (${type})\n*Raisons*:\n${reasonList}`
          : `⚠️ *Transaction suspecte (non bloquée)*\n*Utilisateur*: \`${userId}\`\n*Score Fraude*: ${score}/100\n*Montant*: ${amount} ${currency} (${type})\n*Raisons*:\n${reasonList}`;

        await SlackService.sendSecurity(message).catch((e) =>
          logger.error(`Slack alert error: ${e.message}`),
        );
      }

      return {
        score,
        isSuspicious,
        block,
        reasons,
      };
    } catch (err: any) {
      logger.error(`[FRAUD] Erreur lors de l'évaluation fraude: ${err.message}`);
      // En cas d'erreur de calcul, ne pas bloquer par défaut pour éviter de pénaliser un utilisateur légitime
      return { score: 0, isSuspicious: false, block: false, reasons: [] };
    }
  }
}
