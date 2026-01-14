import axios from 'axios';
import logger from '../utils/logger';

export class SlackService {
  private static readonly WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
  private static readonly ERROR_WEBHOOK_URL = process.env.SLACK_ERROR_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

  /**
   * Send a notification to Slack
   */
  static async sendNotification(message: string, isError: boolean = false) {
    const webhookUrl = isError ? this.ERROR_WEBHOOK_URL : this.WEBHOOK_URL;

    if (!webhookUrl) {
      logger.warn('Slack Webhook URL not configured. Skipping notification.');
      return;
    }

    try {
      await axios.post(webhookUrl, {
        text: message,
      });
      logger.info(`Slack ${isError ? 'error ' : ''}notification sent successfully`);
    } catch (error: any) {
      logger.error(`Failed to send Slack ${isError ? 'error ' : ''}notification: ${error.message}`);
    }
  }

  /**
   * Send a rich message with blocks (optional, for better formatting)
   */
  static async sendRichNotification(blocks: any[], isError: boolean = false) {
    const webhookUrl = isError ? this.ERROR_WEBHOOK_URL : this.WEBHOOK_URL;

    if (!webhookUrl) {
      logger.warn('Slack Webhook URL not configured. Skipping notification.');
      return;
    }

    try {
      await axios.post(webhookUrl, {
        blocks,
      });
      logger.info(`Slack rich ${isError ? 'error ' : ''}notification sent successfully`);
    } catch (error: any) {
      logger.error(`Failed to send Slack rich ${isError ? 'error ' : ''}notification: ${error.message}`);
    }
  }
}
