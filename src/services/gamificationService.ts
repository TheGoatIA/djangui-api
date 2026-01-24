import User from '../models/User';
import logger from '../utils/logger';
import { NotificationService } from './notificationService';

export class GamificationService {
  /**
   * Add XP to a user and handle leveling up
   */
  static async addXP(userId: string, amount: number) {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      user.xp += amount;

      // Simple leveling logic: level = floor(sqrt(xp / 100)) + 1
      // Level 1: 0-99 XP
      // Level 2: 100-399 XP
      // Level 3: 400-899 XP
      const newLevel = Math.floor(Math.sqrt(user.xp / 100)) + 1;

      if (newLevel > user.level) {
        const oldLevel = user.level;
        user.level = newLevel;

        // Notify user of level up
        NotificationService.sendToUser(userId, {
          title: '',
          body: '',
          translationKey: 'LEVEL_UP',
          translationData: { oldLevel, newLevel },
          data: { type: 'level_up', level: String(newLevel) },
        }).catch((err) => logger.error(`Level up notification error: ${err.message}`));
      }

      await user.save();
      return { xp: user.xp, level: user.level };
    } catch (error: any) {
      logger.error(`Error adding XP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deduct XP from a user (punishment)
   */
  static async deductXP(userId: string, amount: number, reason: string) {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      const oldXP = user.xp;
      user.xp = Math.max(0, user.xp - amount);
      const lostXP = oldXP - user.xp;

      // Recalculate level if necessary (though usually we don't level down,
      // but let's keep it consistent if desired. Here we just deduct)

      NotificationService.sendToUser(userId, {
        title: '',
        body: '',
        translationKey: 'XP_PENALTY',
        translationData: { amount: lostXP, reason },
        data: { type: 'xp_deduction', amount: String(lostXP), reason },
      }).catch((err) => logger.error(`XP deduction notification error: ${err.message}`));

      await user.save();
      return { xp: user.xp, level: user.level };
    } catch (error: any) {
      logger.error(`Error deducting XP: ${error.message}`);
      throw error;
    }
  }

  /**
   * Award a badge to a user
   */
  static async awardBadge(userId: string, badgeName: string, icon: string) {
    try {
      const user = await User.findById(userId);
      if (!user) return;

      // Check if user already has this badge
      const hasBadge = user.badges.some((b) => b.name === badgeName);
      if (hasBadge) return;

      user.badges.push({
        name: badgeName,
        icon,
        awardedAt: new Date(),
      });

      NotificationService.sendToUser(userId, {
        title: '',
        body: '',
        translationKey: 'BADGE_AWARDED',
        translationData: { badgeName, icon },
        data: { type: 'badge_awarded', badgeName },
      }).catch((err) => logger.error(`Badge notification error: ${err.message}`));

      await user.save();
      return user.badges;
    } catch (error: any) {
      logger.error(`Error awarding badge: ${error.message}`);
      throw error;
    }
  }
}
