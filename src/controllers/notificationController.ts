import { Request, Response, NextFunction } from 'express';
import Notification from '../models/Notification';
import { AppError } from '../middleware/errorHandler';

export class NotificationController {
    /**
     * Get all notifications for the current user
     */
    static async getMyNotifications(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 20;
            const skip = (page - 1) * limit;

            const notifications = await Notification.find({ userId: (req as any).user.id })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit);

            const total = await Notification.countDocuments({ userId: (req as any).user.id });

            res.status(200).json({
                status: 'success',
                results: notifications.length,
                total,
                page,
                totalPages: Math.ceil(total / limit),
                data: notifications,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Get count of unread notifications
     */
    static async getUnreadCount(req: Request, res: Response, next: NextFunction) {
        try {
            const count = await Notification.countDocuments({
                userId: (req as any).user.id,
                isRead: false,
            });

            res.status(200).json({
                status: 'success',
                data: { count },
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Mark a notification as read
     */
    static async markAsRead(req: Request, res: Response, next: NextFunction) {
        try {
            const notification = await Notification.findOneAndUpdate(
                { _id: req.params.id, userId: (req as any).user.id },
                { isRead: true },
                { new: true },
            );

            if (!notification) {
                return next(new AppError('No notification found with that ID', 404));
            }

            res.status(200).json({
                status: 'success',
                data: notification,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Mark all notifications as read for current user
     */
    static async markAllAsRead(req: Request, res: Response, next: NextFunction) {
        try {
            await Notification.updateMany({ userId: (req as any).user.id, isRead: false }, { isRead: true });

            res.status(200).json({
                status: 'success',
                message: 'All notifications marked as read',
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Delete a notification
     */
    static async deleteNotification(req: Request, res: Response, next: NextFunction) {
        try {
            const notification = await Notification.findOneAndDelete({
                _id: req.params.id,
                userId: (req as any).user.id,
            });

            if (!notification) {
                return next(new AppError('No notification found with that ID', 404));
            }

            res.status(204).json({
                status: 'success',
                data: null,
            });
        } catch (error) {
            next(error);
        }
    }
}
