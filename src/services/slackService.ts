import axios from 'axios';
import logger from '../utils/logger';

export class SlackService {
  private static readonly WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

  /**
   * Send a notification to Slack
   */
  static async sendNotification(message: string) {
    if (!this.WEBHOOK_URL) {
      logger.warn('Slack Webhook URL not configured. Skipping notification.');
      return;
    }

    try {
      await axios.post(this.WEBHOOK_URL, {
        text: message,
      });
      logger.info('Slack notification sent successfully');
    } catch (error: any) {
      logger.error(`Failed to send Slack notification: ${error.message}`);
    }
  }

  /**
   * Send a rich message with blocks (optional, for better formatting)
   */
  static async sendRichNotification(blocks: any[]) {
    if (!this.WEBHOOK_URL) {
      logger.warn('Slack Webhook URL not configured. Skipping notification.');
      return;
    }

    try {
      await axios.post(this.WEBHOOK_URL, {
        blocks,
      });
      logger.info('Slack rich notification sent successfully');
    } catch (error: any) {
      logger.error(`Failed to send Slack rich notification: ${error.message}`);
    }
  }
}
