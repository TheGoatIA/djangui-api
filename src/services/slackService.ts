import axios from 'axios';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';

/**
 * Routing table for dedicated Slack channels. Each category falls back to a
 * more general channel, and ultimately to SLACK_WEBHOOK_URL, so nothing
 * silently stops alerting just because a specific channel hasn't been set up
 * yet — see DEPLOYMENT.md § Alerting Slack for the full list to create.
 */
type SlackChannel = 'default' | 'audit' | 'alert' | 'security' | 'finance' | 'transactions';

const resolveChannelUrl = (): Record<SlackChannel, string | undefined> => {
  const base = process.env.SLACK_WEBHOOK_URL;
  const alert = process.env.SLACK_WEBHOOK_ALERT || process.env.SLACK_ERROR_WEBHOOK_URL || base;
  const security = process.env.SLACK_WEBHOOK_SECURITY || alert;
  return {
    default: base,
    audit: process.env.SLACK_WEBHOOK_AUDIT || base,
    alert,
    security,
    finance: process.env.SLACK_WEBHOOK_FINANCE || base,
    transactions: process.env.SLACK_WEBHOOK_TRANSACTIONS || process.env.SLACK_WEBHOOK_FINANCE || base,
  };
};

export class SlackService {
  private static readonly WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
  private static readonly ERROR_WEBHOOK_URL =
    process.env.SLACK_ERROR_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

  /**
   * Send a notification to Slack. Kept for backward compatibility with
   * existing call sites (general channel, or the legacy error channel).
   * New call sites should prefer the category-specific methods below
   * (sendAudit/sendAlert/sendSecurity/sendFinance/sendTransaction) so the
   * message reaches the right dedicated channel instead of the catch-all.
   */
  static async sendNotification(message: string, isError: boolean = false) {
    const webhookUrl = isError ? this.ERROR_WEBHOOK_URL : this.WEBHOOK_URL;
    return this.post(webhookUrl, { text: message }, isError ? 'alert' : 'default');
  }

  /** Actions administratives à fort impact (crédit wallet, changement de rôle, export DB...) */
  static async sendAudit(message: string) {
    return this.post(resolveChannelUrl().audit, { text: message }, 'audit');
  }

  /** Erreurs système critiques (sauvegarde/restauration échouée, remboursement automatique échoué, exception non gérée) */
  static async sendAlert(message: string) {
    return this.post(resolveChannelUrl().alert, { text: message }, 'alert');
  }

  /** Fraude, activité suspecte, signatures de webhook invalides */
  static async sendSecurity(message: string) {
    return this.post(resolveChannelUrl().security, { text: message }, 'security');
  }

  /** Réconciliation, écarts financiers, abonnements/churn */
  static async sendFinance(message: string) {
    return this.post(resolveChannelUrl().finance, { text: message }, 'finance');
  }

  /** Transactions individuelles à surveiller (gros montants, paiements, remboursements) */
  static async sendTransaction(message: string) {
    return this.post(resolveChannelUrl().transactions, { text: message }, 'transactions');
  }

  private static async post(webhookUrl: string | undefined, payload: any, category: string) {
    if (!webhookUrl?.startsWith('https://hooks.slack.com/')) {
      logger.debug(
        `Slack Webhook URL not configured or is a placeholder for category "${category}". Skipping notification.`,
      );
      return;
    }

    const start = Date.now();
    try {
      await axios.post(webhookUrl, payload);
      logger.info(`Slack notification sent successfully (${category})`);
      MonitoringService.recordExternalApiRequest('slack', category, 'success');
    } catch (error: any) {
      logger.error(`Failed to send Slack notification (${category}): ${error.message}`);
      MonitoringService.recordExternalApiRequest('slack', category, 'failure');
    } finally {
      MonitoringService.observeExternalApiDuration('slack', category, (Date.now() - start) / 1000);
    }
  }

  /**
   * Send a rich message with blocks (optional, for better formatting).
   * `channel` picks a dedicated webhook the same way the category methods
   * above do; omit it (or pass 'default'/'alert' via `isError`) to keep the
   * legacy two-webhook behavior for existing call sites.
   */
  static async sendRichNotification(
    blocks: any[],
    isError: boolean = false,
    channel?: SlackChannel,
  ) {
    const webhookUrl = channel
      ? resolveChannelUrl()[channel]
      : isError
        ? this.ERROR_WEBHOOK_URL
        : this.WEBHOOK_URL;

    if (!webhookUrl || !webhookUrl.startsWith('https://hooks.slack.com/')) {
      logger.debug('Slack Webhook URL not configured or is a placeholder. Skipping rich notification.');
      return;
    }

    try {
      await axios.post(webhookUrl, {
        blocks,
      });
      logger.info(`Slack rich ${isError ? 'error ' : ''}notification sent successfully`);
    } catch (error: any) {
      logger.error(
        `Failed to send Slack rich ${isError ? 'error ' : ''}notification: ${error.message}`,
      );
    }
  }
}
