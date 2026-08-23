import admin from '../config/firebase';
import User from '../models/User';
import Notification from '../models/Notification';
import logger from '../utils/logger';
import { messaging } from 'firebase-admin';
import { I18nService } from './i18nService';
import { MonitoringService } from './monitoringService';

export interface NotificationPayload {
  title: string;
  body: string;
  category?: 'transactional' | 'important' | 'informational';
  data?: Record<string, string>;
  imageUrl?: string;
  translationKey?: string;
  translationData?: Record<string, any>;
}

export class NotificationService {
  /**
   * Send notification to a specific user using their FCM tokens
   */
  static async sendToUser(userId: string, payload: NotificationPayload) {
    try {
      // 1. Send via FCM
      const user = await User.findById(userId).select('fcmTokens language preferences');
      if (!user) return;

      const category = payload.category || 'transactional';

      // 2. Handle localization if key is provided
      if (payload.translationKey) {
        const { title, body } = I18nService.translateNotification(
          user.language || 'fr',
          payload.translationKey,
          payload.translationData || {},
        );
        payload.title = title;
        payload.body = body;
      }

      // 3. Persist notification in database
      await Notification.create({
        userId,
        title: payload.title,
        body: payload.body,
        category,
        data: payload.data,
      });

      // 4. Frequency Filtering Logic
      const frequency = user.preferences?.notificationFrequency || 'medium';
      let shouldPush = true;

      if (category === 'important' && frequency === 'low') {
        shouldPush = false;
      } else if (category === 'informational' && frequency !== 'high') {
        shouldPush = false;
      }

      if (!shouldPush) {
        logger.info(
          `Push notification skipped for user ${userId} due to frequency settings (${frequency}) and category (${category}): ${payload.title}`,
        );
        MonitoringService.recordNotificationEvent('skipped', 'frequency_limit');
        return;
      }

      if (!user.fcmTokens || user.fcmTokens.length === 0) {
        logger.info(
          `No FCM tokens found for user ${userId}. Push skiped, but saved to history: ${payload.title}`,
        );
        MonitoringService.recordNotificationEvent('skipped', 'no_tokens');
        return;
      }

      // Guard: Firebase may not be initialized in dev if credentials are missing
      if (!admin.apps.length) {
        logger.debug(`[FCM] Firebase not initialized — push skipped for user ${userId}: ${payload.title}`);
        MonitoringService.recordNotificationEvent('skipped', 'firebase_not_configured');
        return;
      }

      const message: messaging.MulticastMessage = {
        notification: {
          title: payload.title,
          body: payload.body,
          imageUrl: payload.imageUrl,
        },
        data: payload.data,
        tokens: user.fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      logger.info(
        `Notifications sent: ${response.successCount} success, ${response.failureCount} failure`,
      );

      if (response.successCount > 0)
        MonitoringService.recordNotificationEvent('success', 'delivered');
      if (response.failureCount > 0)
        MonitoringService.recordNotificationEvent('failure', 'fcm_error');

      // Cleanup invalid tokens
      if (response.failureCount > 0) {
        const invalidTokens: string[] = [];
        response.responses.forEach((resp: messaging.SendResponse, idx: number) => {
          if (
            !resp.success &&
            (resp.error?.code === 'messaging/invalid-registration-token' ||
              resp.error?.code === 'messaging/registration-token-not-registered')
          ) {
            invalidTokens.push(user.fcmTokens[idx]);
          }
        });

        if (invalidTokens.length > 0) {
          await User.findByIdAndUpdate(userId, {
            $pull: { fcmTokens: { $in: invalidTokens } },
          });
          logger.info(`Removed ${invalidTokens.length} invalid tokens for user ${userId}`);
        }
      }
    } catch (error: any) {
      logger.error(`Failed to send notification to user ${userId}: ${error.message}`);
      MonitoringService.recordNotificationEvent('failure', 'internal_error');
    }
  }

  /**
   * Send notification to a topic
   */
  static async sendToTopic(topic: string, payload: NotificationPayload) {
    try {
      // Guard: Firebase may not be initialized in dev if credentials are missing
      if (!admin.apps.length) {
        logger.debug(`[FCM] Firebase not initialized — topic push skipped (${topic}): ${payload.title}`);
        return;
      }

      const message: messaging.Message = {
        notification: {
          title: payload.title,
          body: payload.body,
          imageUrl: payload.imageUrl,
        },
        data: payload.data,
        topic,
      };

      await admin.messaging().send(message);
      logger.info(`Notification sent to topic ${topic}: ${payload.title}`);
    } catch (error: any) {
      logger.error(`Failed to send notification to topic ${topic}: ${error.message}`);
    }
  }
}
