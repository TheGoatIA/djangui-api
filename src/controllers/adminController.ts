import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';
import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import Challenge from '../models/Challenge';
import SystemSetting from '../models/SystemSetting';
import AIUsage from '../models/AIUsage';
import { NotificationService } from '../services/notificationService';
import { AppError } from '../middleware/errorHandler';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import Redis from 'ioredis';
import os from 'os';
import { AuditService } from '../services/auditService';
import { EmailService } from '../services/emailService';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

export class AdminController {
  // --- AI ANALYTICS ---

  // Get AI Usage Aggregated Stats
  static async getAIUsageStats(req: Request, res: Response, next: NextFunction) {
    try {
      // 1. Total Cost & Tokens
      const totalStats = await AIUsage.aggregate([
        {
          $group: {
            _id: null,
            totalCost: { $sum: '$cost' },
            totalTokens: { $sum: '$totalTokens' },
            promptTokens: { $sum: '$promptTokens' },
            completionTokens: { $sum: '$completionTokens' },
            totalCalls: { $sum: 1 },
            avgLatency: { $avg: '$durationMs' },
          },
        },
      ]);

      // 2. Cost by Model
      const modelStats = await AIUsage.aggregate([
        {
          $group: {
            _id: '$modelName',
            cost: { $sum: '$cost' },
            count: { $sum: 1 },
          },
        },
        { $sort: { cost: -1 } },
      ]);

      // 3. Top Users by Cost
      const userStats = await AIUsage.aggregate([
        { $match: { userId: { $exists: true } } },
        {
          $group: {
            _id: '$userId',
            totalCost: { $sum: '$cost' },
            totalCalls: { $sum: 1 },
          },
        },
        { $sort: { totalCost: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: '$user' },
        {
          $project: {
            email: '$user.email',
            firstName: '$user.firstName',
            lastName: '$user.lastName',
            totalCost: 1,
            totalCalls: 1,
          },
        },
      ]);

      res.status(200).json({
        status: 'success',
        data: {
          totals: totalStats[0] || { totalCost: 0, totalTokens: 0, totalCalls: 0 },
          models: modelStats,
          topUsers: userStats,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Get AI Usage Logs (List)
  static async getAIUsageLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const logs = await AIUsage.find()
        .populate('userId', 'email firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await AIUsage.countDocuments();

      res.status(200).json({
        status: 'success',
        results: logs.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: logs,
      });
    } catch (error) {
      next(error);
    }
  }

  // --- SYSTEM MANAGEMENT ---

  // 1. Database Backup (Mongodump)
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
          console.error(`Backup error: ${error}`);
          const isCommandNotFound =
            error.message.includes('not recognized') || // Windows
            error.message.includes('not found') || // Linux/Mac
            error.code === 127;

          if (isCommandNotFound) {
            return next(
              new AppError(
                'Backup failed: mongodump tool not found on server. Please install MongoDB Database Tools and add to PATH.',
                500,
              ),
            );
          }
          return next(new AppError(`Backup failed execution: ${error.message}`, 500));
        }

        // For simplicity, we define success if command runs.
        // In a real scenario, we might zip the folder and return the stream.
        res.status(200).json({
          status: 'success',
          message: 'Backup initiated successfully',
          path: backupPath,
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
          serverTime: new Date(),
        },
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

      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      const fileStats = files.map((file) => {
        const stats = fs.statSync(path.join(logsDir, file));
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
        };
      });

      res.status(200).json({
        status: 'success',
        data: fileStats.sort((a, b) => b.modified.getTime() - a.modified.getTime()),
      });
    } catch (error) {
      next(error);
    }
  }

  static async downloadLog(req: Request, res: Response, next: NextFunction) {
    try {
      let { filename } = req.params;
      const logsDir = path.join(__dirname, '../../logs');

      // Alias 'combined.log' and 'error.log' to today's log
      if (filename === 'combined.log' || filename === 'error.log') {
        const today = new Date().toISOString().split('T')[0];
        const prefix = filename.split('.')[0];
        filename = `${prefix}-${today}.log`;
      }

      const filePath = path.join(logsDir, filename);

      if (!fs.existsSync(filePath)) {
        return next(
          new AppError(
            `Log file not found: ${filename} (Aliases tried: combined.log -> today)`,
            404,
          ),
        );
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
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            totalIncome: {
              $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] },
            },
            totalExpense: {
              $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 30 }, // Last 30 days
      ]);

      // Category breakdown
      const categoryBreakdown = await Transaction.aggregate([
        { $match: { type: 'expense' } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]);

      res.status(200).json({
        status: 'success',
        data: {
          dailyVolume,
          categoryBreakdown,
        },
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

      // 4. Chart Data (Last 7 Days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 6);
      startDate.setHours(0, 0, 0, 0);

      const chartAggregation = await Transaction.aggregate([
        {
          $match: {
            date: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
              // We use day of week name in French for frontend if we want direct mapping,
              // but simpler to send date and format in frontend.
              // However, the mock data uses "Lun", "Mar" etc.
              // Let's send the date and let frontend format it.
            },
            actual: {
              $sum: {
                $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0],
              },
            },
            planned: {
              $sum: {
                $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0],
              },
            },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]);

      // Fill missing days
      const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      const filledChartData = [];
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const dayName = days[d.getDay()];
        const found = chartAggregation.find((c) => c._id.date === dateStr);
        filledChartData.push({
          name: dayName,
          date: dateStr,
          actual: found ? found.actual : 0,
          planned: found ? found.planned : 0,
        });
      }

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
          chartData: filledChartData,
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

  // Get User Details (Aggregation)
  static async getUserDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const user = await User.findById(id);

      if (!user) {
        return next(new AppError('No user found with that ID', 404));
      }

      // Fetch recent transactions for this user
      const transactions = await Transaction.find({ userId: id }).sort({ date: -1 }).limit(10);

      // Calculate total volume for this user
      const volumeStats = await Transaction.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]);

      res.status(200).json({
        status: 'success',
        data: {
          user,
          transactions,
          stats: volumeStats,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Update User Details
  static async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      // Filter allowed fields to prevent arbitrary updates (e.g. password)
      const allowedFields = [
        'firstName',
        'lastName',
        'email',
        'phone',
        'role',
        'isActive',
        'monthlyIncome',
        'country',
        'avatar',
        'subscription', // Allow updating subscription directly if needed
      ];

      const updates: any = {};
      Object.keys(req.body).forEach((key) => {
        if (allowedFields.includes(key)) {
          updates[key] = req.body[key];
        }
      });

      const user = await User.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true,
      });

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
      const { userIds, title, body, data, topic, type, imageUrl } = req.body;

      // Validation basics
      if (!title || !body) {
        return next(new AppError('Title and body are required', 400));
      }

      const payload = { title, body, data, imageUrl };
      let count = 0;
      let targetUsers: any[] = [];

      // 1. Determine Target Audience
      if (type === 'specific') {
        if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
          return next(new AppError('userIds array is required for specific targeting', 400));
        }
        // We don't query DB here, loop below handles individual sends (or could fetch valid ones)
        // But logic below expects a list of IDs for promise mapping if we stick to old style,
        // OR we query users to get their tokens if we want to bulk send?
        // The service expects `sendToUser(id, payload)`.
        // Let's just pass the IDs.
        targetUsers = userIds.map((id: string) => ({ _id: id }));
      } else if (userIds && userIds.length > 0) {
        // Fallback for backward compatibility if `type` not provided but `userIds` is
        targetUsers = userIds.map((id: string) => ({ _id: id }));
      } else if (topic) {
        // Topic send - direct handled
        await NotificationService.sendToTopic(topic, payload);
        return res.status(200).json({
          status: 'success',
          message: `Notification sent successfully to topic: ${topic}`,
        });
      } else {
        // Bulk Targeting Logic
        let query: any = {};

        switch (type) {
          case 'all':
            // Users with tokens
            query = { fcmTokens: { $exists: true, $not: { $size: 0 } } };
            break;

          case 'android':
            query = {
              $or: [
                { 'deviceInfo.platform': 'android' }, // Legacy/Root
                { 'deviceInfo.platform': 'Android' },
                { 'sessions.deviceInfo.platform.type': 'android' }, // Session based
              ],
              fcmTokens: { $exists: true, $not: { $size: 0 } },
            };
            break;

          case 'ios':
            query = {
              $or: [
                { 'deviceInfo.platform': 'ios' },
                { 'deviceInfo.platform': 'iOS' },
                { 'sessions.deviceInfo.platform.type': 'ios' },
              ],
              fcmTokens: { $exists: true, $not: { $size: 0 } },
            };
            break;

          case 'premium':
            query = {
              'subscription.plan': 'premium',
              'subscription.status': 'active',
              fcmTokens: { $exists: true, $not: { $size: 0 } },
            };
            break;

          default:
            return next(
              new AppError(
                'Invalid notification type. Use: specific, all, android, ios, premium',
                400,
              ),
            );
        }

        // Fetch only IDs
        targetUsers = await User.find(query).select('_id');
      }

      if (targetUsers.length === 0) {
        return res.status(200).json({
          status: 'success',
          message: 'No users found matching the criteria.',
        });
      }

      // 2. Batch Send using Chunks to prevent memory/connection exhaustion
      const CHUNK_SIZE = 100;
      count = targetUsers.length;

      // Helper function to chunk array
      const chunkArray = (arr: any[], size: number) => {
        return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
          arr.slice(i * size, i * size + size),
        );
      };

      const chunks = chunkArray(targetUsers, CHUNK_SIZE);

      // Process chunks sequentially
      for (const chunk of chunks) {
        const promises = chunk.map((u: any) => NotificationService.sendToUser(u._id, payload));
        await Promise.allSettled(promises);
      }

      res.status(200).json({
        status: 'success',
        message: `Notification sent successfully to ${count} targets (Processed in ${chunks.length} batches)`,
      });
    } catch (error) {
      next(error);
    }
  }

  // Send Email (Admin Only)
  static async sendEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { to, subject, text, html } = req.body;

      // Basic validation
      if (!to || !subject || !text) {
        return next(new AppError('To, Subject, and Text are required fields.', 400));
      }

      await EmailService.sendEmail(to, subject, text, html);

      res.status(200).json({
        status: 'success',
        message: `Email sent successfully to ${to}`,
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

  // 10. Server Resource Monitoring
  static async getServerResources(req: Request, res: Response, next: NextFunction) {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      const resources = {
        memory: {
          total: `${(totalMem / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          free: `${(freeMem / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          used: `${(usedMem / (1024 * 1024 * 1024)).toFixed(2)} GB`,
          percentageUsed: `${((usedMem / totalMem) * 100).toFixed(2)}%`,
        },
        processMemory: process.memoryUsage(),
        cpu: {
          model: os.cpus()[0].model,
          count: os.cpus().length,
          loadAvg: os.loadavg(), // [1, 5, 15] mins
        },
        os: {
          platform: os.platform(),
          release: os.release(),
          uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
        },
        timestamp: new Date(),
      };

      res.status(200).json({
        status: 'success',
        data: resources,
      });
    } catch (error) {
      next(error);
    }
  }

  // 11. Audit Logs Visibility
  static async getAuditLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const query: any = {};
      if (req.query.userId) query.userId = req.query.userId;
      if (req.query.action) query.action = req.query.action;
      if (req.query.resource) query.resource = req.query.resource;

      const result = await AuditService.getLogs(query, { page, limit });
      // console.log('Audit Logs Result:', JSON.stringify(result, null, 2)); // DEBUG LOG

      res.status(200).json({
        status: 'success',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  }
  // --- GOALS MANAGEMENT ---
  static async getAllGoals(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const goals = await import('../models/SavingGoal').then((m) =>
        m.default
          .find()
          .populate('userId', 'email firstName lastName')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit),
      );

      const total = await import('../models/SavingGoal').then((m) => m.default.countDocuments());

      res.status(200).json({
        status: 'success',
        results: goals.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: goals,
      });
    } catch (error) {
      next(error);
    }
  }

  static async deleteGoal(req: Request, res: Response, next: NextFunction) {
    try {
      const goal = await import('../models/SavingGoal').then((m) =>
        m.default.findByIdAndDelete(req.params.id),
      );
      if (!goal) return next(new AppError('No goal found with that ID', 404));
      res.status(204).json({ status: 'success', data: null });
    } catch (error) {
      next(error);
    }
  }

  // --- DATABASE MONITORING ---
  static async getDatabaseStats(req: Request, res: Response, next: NextFunction) {
    try {
      if (!mongoose.connection.db) {
        throw new AppError('Database connection not established', 500);
      }

      // MongoDB Stats
      const dbStats = await mongoose.connection.db.command({ dbStats: 1 });
      const collections = await mongoose.connection.db.listCollections().toArray();
      const collectionStats = await Promise.all(
        collections.map(async (col) => {
          try {
            const stats = await mongoose.connection.db!.command({ collStats: col.name });
            return {
              name: col.name,
              count: stats.count,
              size: stats.size,
              avgObjSize: stats.avgObjSize,
              storageSize: stats.storageSize,
            };
          } catch (err) {
            return {
              name: col.name,
              count: 0,
              size: 0,
              avgObjSize: 0,
              storageSize: 0,
              error: 'Stats unavailable',
            };
          }
        }),
      );

      // Redis Stats
      let redisInfo = {};
      try {
        const info = await redis.info();
        // Parse redis info string into object
        redisInfo = info.split('\r\n').reduce((acc: any, line) => {
          const parts = line.split(':');
          if (parts.length === 2) {
            acc[parts[0]] = parts[1];
          }
          return acc;
        }, {});
      } catch (e) {
        redisInfo = { error: 'Redis connection failed' };
      }

      res.status(200).json({
        status: 'success',
        data: {
          mongo: {
            dbName: dbStats.db,
            objects: dbStats.objects,
            avgObjSize: dbStats.avgObjSize,
            dataSize: dbStats.dataSize,
            storageSize: dbStats.storageSize,
            indexes: dbStats.indexes,
            indexSize: dbStats.indexSize,
            collections: collectionStats,
          },
          redis: redisInfo,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getConnectionLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const ConnectionLog = await import('../models/ConnectionLog').then((m) => m.default);

      const logs = await ConnectionLog.find()
        .populate('userId', 'email firstName lastName')
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit);

      const total = await ConnectionLog.countDocuments();

      res.status(200).json({
        status: 'success',
        results: logs.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: logs,
      });
    } catch (error) {
      next(error);
    }
  }

  static async exportDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      if (!mongoose.connection.db) {
        throw new AppError('Database connection not established', 500);
      }

      const collections = await mongoose.connection.db.listCollections().toArray();
      const exportData: Record<string, any[]> = {};

      for (const col of collections) {
        const documents = await mongoose.connection.db.collection(col.name).find({}).toArray();
        exportData[col.name] = documents;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `db_dump_${timestamp}.json`;

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

      res.status(200).send(JSON.stringify(exportData, null, 2));
    } catch (error) {
      next(error);
    }
  }
}
