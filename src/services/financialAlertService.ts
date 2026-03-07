import { SlackService } from './slackService';
import { EmailService } from './emailService';
import logger from '../utils/logger';
import User from '../models/User';

export interface AlertPayload {
  level: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

export class FinancialAlertService {
  private static readonly ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
    .split(',')
    .filter((e) => e);
  private static readonly HIGH_TRANSACTION_THRESHOLD = 50000; // 50,000 XAF

  /**
   * Envoie une alerte critique via Slack et Email
   */
  static async sendAlert(payload: AlertPayload) {
    const { level, title, message, metadata } = payload;
    const formattedMessage = `[${level.toUpperCase()}] ${title}\n${message}${metadata ? '\nMetadata: ' + JSON.stringify(metadata, null, 2) : ''}`;

    // 1. Log local
    if (level === 'critical') {
      logger.error(`[FINANCIAL-ALERT] ${formattedMessage}`);
    } else {
      logger.warn(`[FINANCIAL-ALERT] ${formattedMessage}`);
    }

    // 2. Slack Notification
    try {
      if (level === 'critical') {
        const blocks = [
          {
            type: 'header',
            text: { type: 'plain_text', text: `🚨 ALERTE CRITIQUE : ${title}` },
          },
          {
            type: 'section',
            text: { type: 'mrkd_word', text: `*Message:* ${message}` },
          },
        ];
        if (metadata) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkd_word', text: `\`\`\`${JSON.stringify(metadata, null, 2)}\`\`\`` },
          });
        }
        await SlackService.sendRichNotification(blocks, true);
      } else {
        await SlackService.sendNotification(formattedMessage, level === 'warning');
      }
    } catch (err: any) {
      logger.error(`Alerting Error (Slack): ${err.message}`);
    }

    // 3. Email Notification (uniquement pour warning/critical)
    if (level !== 'info' && this.ADMIN_EMAILS.length > 0) {
      try {
        const subject = `[KAURI ALERT] ${title}`;
        const html = `
          <h2 style="color: ${level === 'critical' ? '#dc2626' : '#d97706'}">${title}</h2>
          <p><strong>Niveau:</strong> ${level.toUpperCase()}</p>
          <p><strong>Message:</strong> ${message}</p>
          ${metadata ? '<pre>' + JSON.stringify(metadata, null, 2) + '</pre>' : ''}
          <hr>
          <p style="font-size: 12px; color: #666;">Ceci est une alerte financière automatique de Kauri.</p>
        `;

        await Promise.all(
          this.ADMIN_EMAILS.map((email) =>
            EmailService.sendEmail(email, subject, formattedMessage, html),
          ),
        );
      } catch (err: any) {
        logger.error(`Alerting Error (Email): ${err.message}`);
      }
    }
  }

  /**
   * Vérifie si une transaction doit déclencher une alerte (seuil, fraude)
   */
  static async monitorTransaction(data: {
    userId: string;
    amount: number;
    type: string;
    reference: string;
    status: string;
  }) {
    // Alerte pour gros montants
    if (data.amount >= this.HIGH_TRANSACTION_THRESHOLD) {
      const user = await User.findById(data.userId).select('firstName lastName email');
      await this.sendAlert({
        level: 'warning',
        title: 'Transaction à Haut Volume Détectée',
        message: `L'utilisateur ${user?.firstName} ${user?.lastName} a initié un ${data.type} de ${data.amount} XAF.`,
        metadata: {
          userId: data.userId,
          reference: data.reference,
          amount: data.amount,
          type: data.type,
        },
      });
    }

    // Alerte pour échecs critiques
    if (data.status === 'failed' && (data.type === 'withdrawal' || data.type === 'deposit')) {
      await this.sendAlert({
        level: 'warning',
        title: `Échec de ${data.type.toUpperCase()}`,
        message: `Une transaction critique a échoué. Réf: ${data.reference}`,
        metadata: {
          reference: data.reference,
          status: data.status,
          userId: data.userId,
        },
      });
    }
  }

  /**
   * Envoi du rapport exécutif journalier
   */
  static async sendDailyExecutiveReport(stats: any) {
    const title = `Rapport Financier Journalier - ${new Date().toLocaleDateString('fr-FR')}`;
    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📊 ${title}` },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkd_word',
            text: `*Chiffre d'Affaire (Volume):*\n${stats.transactions.totalVolume} XAF`,
          },
          { type: 'mrkd_word', text: `*Revenus Kauri (Frais):*\n${stats.revenue.totalFees} XAF` },
          { type: 'mrkd_word', text: `*Nouveaux Utilisateurs:*\n${stats.growth.newUsers}` },
          { type: 'mrkd_word', text: `*Taux d'Anomalie:*\n${stats.health.anomalyCount}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkd_word', text: `*Balance Globale (AUM):* ${stats.health.totalAUM} XAF` },
      },
    ];

    await SlackService.sendRichNotification(blocks, false);

    if (this.ADMIN_EMAILS.length > 0) {
      const html = `
        <h2>Rapport Exécutif Kauri</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr style="background-color: #f3f4f6;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Métrique</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Valeur</th>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Volume Total Transactions (CA)</td>
            <td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${stats.transactions.totalVolume} XAF</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd; color: #16a34a; font-weight: bold;">Gains Kauri (Frais collectés)</td>
            <td style="padding: 10px; border: 1px solid #ddd; text-align: right; color: #16a34a;">${stats.revenue.totalFees} XAF</td>
          </tr>
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">Total Money AUM (Client)</td>
            <td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${stats.health.totalAUM} XAF</td>
          </tr>
        </table>
      `;
      await Promise.all(
        this.ADMIN_EMAILS.map((email) =>
          EmailService.sendEmail(email, title, 'Voir rapport Slack pour plus de détails.', html),
        ),
      );
    }
  }
}
