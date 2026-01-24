import { Request, Response, NextFunction } from 'express';
import UserActivity from '../models/UserActivity';
import SessionLog from '../models/SessionLog';
import { AppError } from '../middleware/errorHandler';

export class AnalyticsController {
  // 1. Track Feature Usage (Event)
  static async trackEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const { feature, action, details, platform, appVersion } = req.body;
      const userId = (req as any).user.id;

      if (!feature || !action) {
        return next(new AppError('Feature and action are required', 400));
      }

      await UserActivity.create({
        userId,
        feature,
        action,
        details,
        platform,
        appVersion,
      });

      res.status(201).json({ status: 'success' });
    } catch (error) {
      next(error);
    }
  }

  // 2. Start Session
  static async startSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { deviceId, platform, appVersion } = req.body;
      const userId = (req as any).user.id;
      const ip = req.ip;

      // Close any previous active sessions for this device if needed
      // Or we can rely on client to send 'endSession'.
      // But purely for hygiene, we could check.

      const session = await SessionLog.create({
        userId,
        deviceId,
        platform,
        appVersion,
        ip,
        startTime: new Date(),
        isActive: true,
      });

      res.status(201).json({
        status: 'success',
        data: { sessionId: session._id },
      });
    } catch (error) {
      next(error);
    }
  }

  // 3. End Session
  static async endSession(req: Request, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return next(new AppError('Session ID is required', 400));
      }

      const session = await SessionLog.findById(sessionId);
      if (!session) {
        return next(new AppError('Session not found', 404));
      }

      const endTime = new Date();
      const startTime = new Date(session.startTime);
      const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

      session.endTime = endTime;
      session.durationSeconds = durationSeconds;
      session.isActive = false;
      await session.save();

      res.status(200).json({ status: 'success', data: { durationSeconds } });
    } catch (error) {
      next(error);
    }
  }

  // 4. Ping Session (Heartbeat) - Optional, prevents sessions from being open forever if app crashes
  static async pingSession(req: Request, res: Response, next: NextFunction) {
    // Could be implemented to update a 'lastActive' field
    // For now, let's keep it simple with explicit start/end
    res.status(200).json({ status: 'success' });
  }
}
