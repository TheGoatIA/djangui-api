import admin from '../config/firebase';
import User from '../models/User';
import Notification from '../models/Notification';
import logger from '../utils/logger';
import { messaging } from 'firebase-admin';

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export class NotificationService {
  /**
   * Send notification to a specific user using their FCM tokens
   */
  static async sendToUser(userId: string, payload: NotificationPayload) {
    try {
      // 1. Persist notification in database
      await Notification.create({
        userId,
        title: payload.title,
        body: payload.body,
        data: payload.data,
      });

      // 2. Send via FCM
      const user = await User.findById(userId).select('fcmTokens');
      if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
        logger.info(
          `No FCM tokens found for user ${userId}. Push skiped, but saved to history: ${payload.title}`,
        );
        return;
      }

      const message: messaging.MulticastMessage = {
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data,
        tokens: user.fcmTokens,
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      logger.info(
        `Notifications sent: ${response.successCount} success, ${response.failureCount} failure`,
      );

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
    }
  }

  /**
   * Send notification to a topic
   */
  static async sendToTopic(topic: string, payload: NotificationPayload) {
    try {
      const message: messaging.Message = {
        notification: {
          title: payload.title,
          body: payload.body,
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
