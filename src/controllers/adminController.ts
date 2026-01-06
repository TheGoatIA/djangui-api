import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import Challenge from '../models/Challenge';
import SystemSetting from '../models/SystemSetting';
import { NotificationService } from '../services/notificationService';
import { AppError } from '../middleware/errorHandler';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export class AdminController {
    // --- SYSTEM MANAGEMENT ---

    // 1. Database Backup (Mongodump)
    static async backupDatabase(req: Request, res: Response, next: NextFunction) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `backup-${timestamp}`;
            const backupPath = path.join(__dirname, '../../backups', filename);

            // Ensure backups directory exists
            if (!fs.existsSync(path.join(__dirname, '../../backups'))) {
                fs.mkdirSync(path.join(__dirname, '../../backups'), { recursive: true });
            }

            // Command for mongodump (requires mongodump installed in system)
            // Assuming localhost/27017 and typical connection string
            // NOTE: For password protected DBs, need to add --username and --password
            const command = `mongodump --uri="${process.env.MONGO_URI}" --out="${backupPath}"`;

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Backup error: ${error.message}`);
                    return next(new AppError('Backup failed execution', 500));
                }

                // For simplicity, we define success if command runs.
                // In a real scenario, we might zip the folder and return the stream.
                res.status(200).json({
                    status: 'success',
                    message: 'Backup initiated successfully',
                    path: backupPath
                });
            });
        } catch (error) {
            next(error);
        }
    }

    // 2. System Health (Redis + Mongo)
    static async getSystemHealth(req: Request, res: Response, next: NextFunction) {
        try {
            const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
            let redisStatus = 'disconnected';

            try {
                await redis.ping();
                redisStatus = 'connected';
            } catch (e) {
                redisStatus = 'error';
            }

            const uptime = process.uptime();

            res.status(200).json({
                status: 'success',
                data: {
                    mongo: mongoStatus,
                    redis: redisStatus,
                    uptime: `${Math.floor(uptime / 60)} minutes`,
                    memory: process.memoryUsage(),
                    serverTime: new Date()
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // 3. Log Management
    static async getLogs(req: Request, res: Response, next: NextFunction) {
        try {
            const logsDir = path.join(__dirname, '../../logs');
            if (!fs.existsSync(logsDir)) {
                return res.status(200).json({ status: 'success', data: [] });
            }

            const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
            const fileStats = files.map(file => {
                const stats = fs.statSync(path.join(logsDir, file));
                return {
                    name: file,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            });

            res.status(200).json({
                status: 'success',
                data: fileStats.sort((a, b) => b.modified.getTime() - a.modified.getTime())
            });
        } catch (error) {
            next(error);
        }
    }

    static async downloadLog(req: Request, res: Response, next: NextFunction) {
        try {
            const { filename } = req.params;
            const filePath = path.join(__dirname, '../../logs', filename);

            if (!fs.existsSync(filePath)) {
                return next(new AppError('Log file not found', 404));
            }

            res.download(filePath);
        } catch (error) {
            next(error);
        }
    }

    // 4. Advanced Financial Analytics
    static async getFinancialAnalytics(req: Request, res: Response, next: NextFunction) {
        try {
            // Aggregation for daily volume
            const dailyVolume = await Transaction.aggregate([
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        totalIncome: {
                            $sum: { $cond: [{ $eq: ["$type", "income"] }, "$amount", 0] }
                        },
                        totalExpense: {
                            $sum: { $cond: [{ $eq: ["$type", "expense"] }, "$amount", 0] }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: -1 } },
                { $limit: 30 } // Last 30 days
            ]);

            // Category breakdown
            const categoryBreakdown = await Transaction.aggregate([
                { $match: { type: 'expense' } },
                { $group: { _id: "$category", total: { $sum: "$amount" } } },
                { $sort: { total: -1 } }
            ]);

            res.status(200).json({
                status: 'success',
                data: {
                    dailyVolume,
                    categoryBreakdown
                }
            });
        } catch (error) {
            next(error);
        }
    }

    // Get Global Stats
    static async getDashboardStats(req: Request, res: Response, next: NextFunction) {
        try {
            // 1. User Stats
            const totalUsers = await User.countDocuments();
            const activeUsers = await User.countDocuments({ isActive: true });
            const premiumUsers = await User.countDocuments({ 'subscription.plan': 'premium' });

            // 2. Financial Stats (Aggregation)
            const transactionsStats = await Transaction.aggregate([
                {
                    $group: {
                        _id: '$type',
                        totalAmount: { $sum: '$amount' },
                        count: { $sum: 1 },
                    },
                },
            ]);

            // 3. System Health (Basic)
            const systemHealth = {
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                timestamp: new Date(),
            };

            res.status(200).json({
                status: 'success',
                data: {
                    users: {
                        total: totalUsers,
                        active: activeUsers,
                        premium: premiumUsers,
                    },
                    financials: transactionsStats,
                    system: systemHealth,
                },
            });
        } catch (error) {
            next(error);
        }
    }

    // Get All Users (with pagination & search)
    static async getAllUsers(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 10;
            const skip = (page - 1) * limit;
            const search = req.query.search as string;

            const query: any = {};
            if (search) {
                query.$or = [
                    { email: { $regex: search, $options: 'i' } },
                    { firstName: { $regex: search, $options: 'i' } },
                    { lastName: { $regex: search, $options: 'i' } },
                ];
            }

            const users = await User.find(query)
                .select('-password')
                .skip(skip)
                .limit(limit)
                .sort('-createdAt');

            const total = await User.countDocuments(query);

            res.status(200).json({
                status: 'success',
                results: users.length,
                total,
                page,
                totalPages: Math.ceil(total / limit),
                data: users,
            });
        } catch (error) {
            next(error);
        }
    }

    // Ban/Unban User
    static async updateUserStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { id } = req.params;
            const { isActive } = req.body;

            const user = await User.findByIdAndUpdate(id, { isActive }, { new: true });

            if (!user) {
                return next(new AppError('No user found with that ID', 404));
            }

            res.status(200).json({
                status: 'success',
                data: {
                    user,
                },
            });
        } catch (error) {
            next(error);
        }
    }
    // Send Push Notification
    static async sendPushNotification(req: Request, res: Response, next: NextFunction) {
        try {
            const { userIds, title, body, data, topic } = req.body;

            if (!title || !body) {
                return next(new AppError('Title and body are required', 400));
            }

            const payload = { title, body, data };
            let count = 0;

            if (userIds && Array.isArray(userIds) && userIds.length > 0) {
                // Send to specific users
                const promises = userIds.map((id: string) => NotificationService.sendToUser(id, payload));
                await Promise.all(promises);
                count = userIds.length;
            } else if (topic) {
                // Send to topic (e.g., 'all_users', 'news')
                await NotificationService.sendToTopic(topic, payload);
                count = 1; // 1 topic
            } else {
                return next(
                    new AppError('Please provide either userIds (array) or a topic to send to', 400),
                );
            }

            res.status(200).json({
                status: 'success',
                message: `Notification sent successfully to ${count} targets`,
            });
        } catch (error) {
            next(error);
        }
    }

    // --- CHALLENGES MANAGEMENT ---
    static async createChallenge(req: Request, res: Response, next: NextFunction) {
        try {
            const challenge = await Challenge.create(req.body);
            res.status(201).json({ status: 'success', data: challenge });
        } catch (error) {
            next(error);
        }
    }

    static async updateChallenge(req: Request, res: Response, next: NextFunction) {
        try {
            const challenge = await Challenge.findByIdAndUpdate(req.params.id, req.body, {
                new: true,
                runValidators: true,
            });
            if (!challenge) return next(new AppError('No challenge found with that ID', 404));
            res.status(200).json({ status: 'success', data: challenge });
        } catch (error) {
            next(error);
        }
    }

    static async deleteChallenge(req: Request, res: Response, next: NextFunction) {
        try {
            const challenge = await Challenge.findByIdAndDelete(req.params.id);
            if (!challenge) return next(new AppError('No challenge found with that ID', 404));
            res.status(204).json({ status: 'success', data: null });
        } catch (error) {
            next(error);
        }
    }

    // --- TRANSACTIONS SUPERVISION ---
    static async getAllTransactions(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 20;
            const skip = (page - 1) * limit;

            const queryObj = { ...req.query };
            const excludedFields = ['page', 'sort', 'limit', 'fields'];
            excludedFields.forEach((el) => delete queryObj[el]);

            // Advanced filtering (e.g. amount > 1000)
            let queryStr = JSON.stringify(queryObj);
            queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);

            const transactions = await Transaction.find(JSON.parse(queryStr))
                .populate('userId', 'email firstName lastName')
                .sort({ date: -1 })
                .skip(skip)
                .limit(limit);

            const total = await Transaction.countDocuments(JSON.parse(queryStr));

            res.status(200).json({
                status: 'success',
                results: transactions.length,
                total,
                page,
                totalPages: Math.ceil(total / limit),
                data: transactions,
            });
        } catch (error) {
            next(error);
        }
    }

    // --- SYSTEM SETTINGS ---
    static async getSystemSettings(req: Request, res: Response, next: NextFunction) {
        try {
            const settings = await SystemSetting.find();
            res.status(200).json({ status: 'success', data: settings });
        } catch (error) {
            next(error);
        }
    }

    static async updateSystemSetting(req: Request, res: Response, next: NextFunction) {
        try {
            const { key, value, description, group, isPublic } = req.body;
            const setting = await SystemSetting.findOneAndUpdate(
                { key },
                { value, description, group, isPublic },
                { new: true, upsert: true, setDefaultsOnInsert: true },
            );
            res.status(200).json({ status: 'success', data: setting });
        } catch (error) {
            next(error);
        }
    }
}
