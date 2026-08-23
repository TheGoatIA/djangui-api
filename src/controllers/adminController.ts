import { notchpayAdminApi } from '../config/notchpay';
import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import logger from '../utils/logger';
import User from '../models/User';
import Transaction from '../models/Transaction';
import Budget from '../models/Budget';
import Challenge from '../models/Challenge';
import SystemSetting from '../models/SystemSetting';
import AIUsage from '../models/AIUsage';
import Tontine from '../models/Tontine';
import Subscription from '../models/Subscription';
import UserActivity from '../models/UserActivity';
import SessionLog from '../models/SessionLog';
import { NotificationService } from '../services/notificationService';
import { CurrencyService } from '../services/currencyService';
import { AppError } from '../middleware/errorHandler';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AuditService } from '../services/auditService';
import { EmailService } from '../services/emailService';
import { DbBackupService } from '../services/dbBackupService';
import redis from '../config/redis';
import Payment from '../models/Payment';
import { PayoutService } from '../services/payoutService';
import { KYCService } from '../services/kycService';
import SupportTicket from '../models/SupportTicket';

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
      const result = await DbBackupService.runBackup();

      res.status(200).json({
        status: 'success',
        message: 'Backup completed successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  // 1b. Database Restore
  static async restoreDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      const { filename } = req.params;

      if (!filename) {
        return next(new AppError('Backup filename is required', 400));
      }

      await DbBackupService.restoreBackup(filename);

      res.status(200).json({
        status: 'success',
        message: 'Database restored successfully',
        file: filename,
      });
    } catch (error) {
      next(error);
    }
  }

    // 2. Comprehensive Real-time System Health (Mongo, Redis, MinIO, NotchPay, Gemini, Email, Firebase, Slack, Server)
  static async getSystemHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const startTime = Date.now();

      // 1. MongoDB Check & Latency
      let mongoStatus = 'disconnected';
      let mongoLatencyMs = 0;
      try {
        const mStart = Date.now();
        if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
          await mongoose.connection.db.admin().ping();
          mongoStatus = 'operational';
          mongoLatencyMs = Date.now() - mStart;
        } else {
          mongoStatus = 'down';
        }
      } catch (err: any) {
        mongoStatus = 'down';
        logger.error(`[Health] Mongo check failed: ${err.message}`);
      }

      // 2. Redis Check & Latency
      let redisStatus = 'disconnected';
      let redisLatencyMs = 0;
      try {
        const rStart = Date.now();
        const pong = await redis.ping();
        if (pong === 'PONG') {
          redisStatus = 'operational';
          redisLatencyMs = Date.now() - rStart;
        } else {
          redisStatus = 'down';
        }
      } catch (err: any) {
        redisStatus = 'down';
        logger.error(`[Health] Redis check failed: ${err.message}`);
      }

      // 3. MinIO / S3 Storage Check
      let storageStatus = 'operational';
      let storageDetails: any = { provider: process.env.STORAGE_PROVIDER || 'minio', bucket: process.env.S3_BUCKET || 'kauri-uploads' };
      try {
        const hasStorageCreds = Boolean(
          process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ENDPOINT || process.env.S3_ENDPOINT
        );
        if (!hasStorageCreds) {
          storageStatus = 'not_configured';
        }
      } catch {
        storageStatus = 'degraded';
      }

      // 4. NotchPay Gateway Check & Live Balance
      let notchpayStatus = 'not_configured';
      let notchpayDetails: any = { configured: false };
      const notchpayConfigured = Boolean(process.env.NOTCHPAY_PUBLIC_KEY && process.env.NOTCHPAY_PRIVATE_KEY);
      if (notchpayConfigured) {
        try {
          const npRes = await notchpayAdminApi.get('/balance');
          if (npRes.data?.balance) {
            notchpayStatus = 'operational';
            notchpayDetails = {
              configured: true,
              balance: npRes.data.balance.available ?? npRes.data.balance.total ?? 0,
              currency: npRes.data.balance.currency || 'XAF',
              environment: npRes.data.balance.environment || 'sandbox',
            };
          } else {
            notchpayStatus = 'operational';
            notchpayDetails = { configured: true };
          }
        } catch (err: any) {
          notchpayStatus = 'degraded';
          notchpayDetails = { configured: true, error: err.message };
        }
      }

      // 5. Gemini AI Engine
      const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
      const geminiStatus = geminiConfigured ? 'operational' : 'not_configured';

      // 6. Email / SMTP Service
      const emailConfigured = Boolean(
        process.env.SMTP_HOST || process.env.EMAIL_HOST || process.env.BREVO_API_KEY || process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY
      );
      const emailStatus = emailConfigured ? 'operational' : 'not_configured';

      // 7. Firebase Cloud Messaging (Push notifications)
      const firebaseConfigured = Boolean(
        process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_PROJECT_ID
      );
      const firebaseStatus = firebaseConfigured ? 'operational' : 'not_configured';

      // 8. Slack Incident Webhook
      const slackConfigured = Boolean(process.env.SLACK_WEBHOOK_URL);
      const slackStatus = slackConfigured ? 'operational' : 'not_configured';

      // Service List with Metadata
      const services = [
        { id: 'mongo', name: 'Base de Données Principale', tech: 'MongoDB', status: mongoStatus, latencyMs: mongoLatencyMs, critical: true, icon: 'database' },
        { id: 'redis', name: 'Cache & Files d\'attente', tech: 'Redis', status: redisStatus, latencyMs: redisLatencyMs, critical: true, icon: 'zap' },
        { id: 'storage', name: 'Stockage Documents & Médias', tech: 'MinIO / S3', status: storageStatus, details: storageDetails, critical: true, icon: 'hard-drive' },
        { id: 'notchpay', name: 'Passerelle Paiements & MoMo', tech: 'NotchPay API', status: notchpayStatus, details: notchpayDetails, critical: true, icon: 'credit-card' },
        { id: 'gemini', name: 'Moteur d\'Intelligence Artificielle', tech: 'Google Gemini Pro', status: geminiStatus, critical: false, icon: 'brain' },
        { id: 'email', name: 'Service d\'E-mails Transactionnels', tech: 'SMTP / Mailer', status: emailStatus, critical: false, icon: 'mail' },
        { id: 'firebase', name: 'Notifications Push Mobiles', tech: 'Firebase FCM', status: firebaseStatus, critical: false, icon: 'bell' },
        { id: 'slack', name: 'Canal d\'Alertes Incidents', tech: 'Slack Webhook', status: slackStatus, critical: false, icon: 'message-square' },
      ];

      const downCritical = services.filter(s => s.critical && (s.status === 'down' || s.status === 'disconnected'));
      const hasDegraded = services.some(s => s.status === 'degraded' || s.status === 'down');
      const overallStatus = downCritical.length > 0 ? 'outage' : (hasDegraded ? 'degraded' : 'healthy');

      const uptimeSeconds = process.uptime();

      res.status(200).json({
        status: 'success',
        data: {
          overallStatus, // 'healthy' | 'degraded' | 'outage'
          timestamp: new Date().toISOString(),
          checkDurationMs: Date.now() - startTime,
          uptime: `${Math.floor(uptimeSeconds / 60)} minutes`,
          uptimeSeconds,
          mongo: mongoStatus,
          redis: redisStatus,
          services,
          integrations: {
            notchpay: { configured: notchpayConfigured, ...notchpayDetails },
            gemini: { configured: geminiConfigured },
            email: { configured: emailConfigured },
            firebase: { configured: firebaseConfigured },
            slack: { configured: slackConfigured },
          },
          memory: process.memoryUsage(),
          serverTime: new Date(),
          system: {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            memory: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Compteurs légers pour le centre de notifications de l'admin (cloche du
  // Topbar) : ce qui attend une action humaine, en un seul appel.
  static async getNotificationsSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const [kycPending, payoutsPending, supportOpen] = await Promise.all([
        User.countDocuments({ kycLevel: 'pending' }),
        Payment.countDocuments({ type: 'withdrawal', status: 'pending' }),
        SupportTicket.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
      ]);

      res.status(200).json({
        status: 'success',
        data: { kycPending, payoutsPending, supportOpen },
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

  // 3b. Create Client Log (from Frontend/Mobile)
  static async createLog(req: Request, res: Response, next: NextFunction) {
    try {
      const { level, message, context, stack, metadata } = req.body;

      if (!message) {
        return next(new AppError('Log message is required', 400));
      }

      const logMethod = (logger as any)[level] || logger.info;
      logMethod.call(logger, {
        message: `[CLIENT] ${message}`,
        level: level || 'info',
        context: context || 'ClientLog',
        stack,
        ...metadata,
        userId: (req as any).user?._id,
      });

      res.status(201).json({
        status: 'success',
        message: 'Log recorded successfully',
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

      // Reject anything that isn't a plain log filename — Express decodes
      // URL-encoded path segments before routing, so without this a request
      // like "..%2F..%2F.env" would resolve outside logsDir via path.join
      // below and let res.download() stream arbitrary files off disk.
      if (!/^[\w.-]+\.log$/.test(filename)) {
        return next(new AppError('Invalid filename', 400));
      }

      const filePath = path.resolve(logsDir, filename);
      if (filePath !== path.join(logsDir, filename) || !filePath.startsWith(logsDir + path.sep)) {
        return next(new AppError('Invalid filename', 400));
      }

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
      // Transactions are stored in each user's own currency at the time — a
      // raw $sum across users mixes FCFA, EUR, USD, etc. totalAmountFCFA
      // converts every amount to FCFA in the pipeline itself (server-side,
      // no need to pull every transaction into Node to convert client-side).
      const ratesToXAF = CurrencyService.getRatesToXAF();
      const rateSwitchBranches = Object.entries(ratesToXAF).map(([currency, rate]) => ({
        case: { $eq: ['$currency', currency] },
        then: rate,
      }));

      // PFM-only transactions: user-declared budget entries (income/expense saisies manuellement).
      // Real financial flows (recharges NotchPay, retraits MoMo) have a paymentMethod set
      // and belong to "Portefeuilles & Séquestres" / "Gains Kauri" — NOT to PFM.
      const PFM_EXCLUDED_METHODS = ['notchpay', 'wallet', 'momo', 'orange_money', 'mtn_momo', 'bank_transfer'];
      const transactionsStats = await Transaction.aggregate([
        {
          $match: {
            paymentMethod: { $nin: PFM_EXCLUDED_METHODS },
            type: { $in: ['income', 'expense'] },
          },
        },
        {
          $group: {
            _id: '$type',
            totalAmount: { $sum: '$amount' },
            totalAmountFCFA: {
              $sum: {
                $multiply: ['$amount', { $switch: { branches: rateSwitchBranches, default: 1 } }],
              },
            },
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

      // 5. Signup growth (all-time, daily counts) — an aggregation returning
      // one row per day costs nothing regardless of user count, unlike the
      // dashboard previously pulling up to 1000 full user records (with PII:
      // email, phone, sessions/IPs...) just to bucket their createdAt client-side,
      // which also silently went wrong past 1000 signups.
            // 6. NotchPay Real Balance
      let notchpayData = {
        balance: 0,
        available: 0,
        total: 0,
        currency: 'XAF',
        status: 'offline',
        environment: 'sandbox',
      };
      try {
        const npRes = await notchpayAdminApi.get('/balance');
        if (npRes.data?.balance) {
          const b = npRes.data.balance;
          notchpayData = {
            balance: b.available ?? b.total ?? 0,
            available: b.available ?? 0,
            total: b.total ?? 0,
            currency: b.currency || 'XAF',
            status: 'active',
            environment: b.environment || 'sandbox',
          };
        }
      } catch (err: any) {
        logger.warn(`[Admin] NotchPay balance fetch failed: ${err.message}`);
      }

      // 7. Kauri Business Revenue & Net Earnings
      const revenueAggregation = await Transaction.aggregate([
        { $match: { status: 'completed' } },
        {
          $group: {
            _id: '$type',
            totalFees: { $sum: { $ifNull: ['$fees', 0] } },
            totalFeesFCFA: {
              $sum: {
                $multiply: [
                  { $ifNull: ['$fees', 0] },
                  { $switch: { branches: rateSwitchBranches, default: 1 } },
                ],
              },
            },
            volume: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]);

      const totalTransactionCommissions = revenueAggregation.reduce(
        (acc, r) => acc + (r.totalFeesFCFA || r.totalFees || 0),
        0
      );

      // Subscription revenue
      const activeSubscriptions = await Subscription.find({
        status: { $in: ['active', 'trialing'] },
      });
      const subscriptionRevenue = activeSubscriptions.reduce((acc, s) => {
        return acc + (s.amount || ((s as any).plan === 'premium' ? 2500 : 0));
      }, 0);

      const kauriEarnings = {
        totalNetRevenue: Math.round(totalTransactionCommissions + subscriptionRevenue),
        commissions: {
          total: Math.round(totalTransactionCommissions),
          withdrawals: Math.round(revenueAggregation.find((r) => r._id === 'withdrawal')?.totalFeesFCFA || 0),
          tontines: Math.round(revenueAggregation.find((r) => r._id === 'tontine_payout' || r._id === 'tontine')?.totalFeesFCFA || 0),
          deposits: Math.round(revenueAggregation.find((r) => r._id === 'deposit')?.totalFeesFCFA || 0),
          savings: Math.round(revenueAggregation.find((r) => r._id === 'savings' || r._id === 'goal')?.totalFeesFCFA || 0),
        },
        subscriptions: {
          total: Math.round(subscriptionRevenue),
          activeSubscribers: activeSubscriptions.length,
        },
        currency: 'FCFA',
      };

            // 8. Real Money (User Wallets + Tontine Escrow)
      const walletAggregation = await User.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, totalWalletBalance: { $sum: { $ifNull: ['$walletBalance', 0] } } } },
      ]);
      const userWallets = walletAggregation[0]?.totalWalletBalance || 0;

      const tontineAggregation = await Tontine.aggregate([
        { $match: { status: { $in: ['active', 'in_progress', 'open'] } } },
        { $group: { _id: null, totalEscrow: { $sum: { $ifNull: ['$totalPot', 0] } } } },
      ]);
      const tontinesEscrow = tontineAggregation[0]?.totalEscrow || 0;

      const realMoney = {
        walletTotal: userWallets + tontinesEscrow,
        userWallets,
        tontinesEscrow,
      };

      const userGrowthAggregation = await User.aggregate([
        { $match: { createdAt: { $exists: true } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, date: '$_id', count: 1 } },
      ]);

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
          userGrowth: userGrowthAggregation,
          notchpay: notchpayData,
          kauriEarnings,
          realMoney,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Get All Users (with pagination & search)
  
  // Get NotchPay Live Balance
  static async getNotchPayBalance(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await notchpayAdminApi.get('/balance');
      res.status(200).json({
        status: 'success',
        data: response.data?.balance || response.data,
      });
    } catch (error: any) {
      next(error);
    }
  }

  
  // Get Wallet & Real Money Summary
  static async getWalletSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const [completedPaymentsAgg, walletAggregation, tontineAggregation] = await Promise.all([
        Payment.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, totalDeposits: { $sum: '$amount' }, count: { $sum: 1 } } },
        ]),
        User.aggregate([
          { $group: { _id: null, totalWalletBalance: { $sum: { $ifNull: ['$walletBalance', 0] } } } },
        ]),
        Tontine.aggregate([
          { $match: { status: { $in: ['active', 'in_progress', 'open'] } } },
          { $group: { _id: null, totalEscrow: { $sum: { $ifNull: ['$totalPot', 0] } } } },
        ]),
      ]);

      const totalRealFlows = completedPaymentsAgg[0]?.totalDeposits || 0;
      const userWallets = walletAggregation[0]?.totalWalletBalance || 0;
      const tontinesEscrow = tontineAggregation[0]?.totalEscrow || 0;

      res.status(200).json({
        status: 'success',
        data: {
          totalWalletBalance: userWallets + tontinesEscrow,
          totalRealFlows,
          currentWalletBalances: userWallets + tontinesEscrow,
          userWallets,
          tontinesEscrow,
        },
      });
    } catch (error) {
      next(error);
    }
  }

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
      const { isActive, status } = req.body;

      const updatePayload: any = {};
      if (isActive !== undefined) updatePayload.isActive = isActive;
      if (status) updatePayload.status = status;

      const user = await User.findByIdAndUpdate(id, updatePayload, { new: true });

      if (!user) {
        return next(new AppError('No user found with that ID', 404));
      }

      AuditService.record(
        {
          userId: (req as any).user._id,
          action: 'USER_STATUS_UPDATE',
          resource: 'User',
          resourceId: id,
          newValue: updatePayload,
          status: 'success',
        },
        req,
      );

      // Notification de suspension / réactivation
      const isSuspended =
        updatePayload.status === 'suspended' ||
        updatePayload.status === 'blocked' ||
        updatePayload.isActive === false;
      const isReactivated = updatePayload.status === 'active' || updatePayload.isActive === true;

      if (isSuspended) {
        NotificationService.sendToUser(id, {
          title: 'Compte Suspendu ⚠️',
          body: "Votre compte Kauri a été suspendu par un administrateur. Contactez le support pour plus d'informations.",
          category: 'important',
          data: { type: 'account_suspended' },
        }).catch((err: any) => logger.error(`Suspension Notification Error: ${err.message}`));
      } else if (isReactivated) {
        NotificationService.sendToUser(id, {
          title: 'Compte Réactivé ✅',
          body: 'Votre compte Kauri a été réactivé. Vous pouvez de nouveau accéder à toutes les fonctionnalités.',
          category: 'important',
          data: { type: 'account_reactivated' },
        }).catch((err: any) => logger.error(`Reactivation Notification Error: ${err.message}`));
      }

      res.status(200).json({
        status: 'success',
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Crédite manuellement le portefeuille d'un utilisateur en mode simulation
   * (test/démo). Bloqué sans condition tant que le mode argent réel est actif,
   * pour ne jamais laisser un admin injecter un solde fictif alors que les
   * soldes représentent de l'argent réel. Montant plafonné, motif obligatoire,
   * toujours audit-loggé.
   */
  static async creditUserWallet(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { amount, reason } = req.body;

      const { FeatureFlagService } = await import('../services/featureFlagService');
      if (await FeatureFlagService.isRealMoneyEnabled()) {
        return next(
          new AppError(
            "Le crédit manuel de portefeuille est désactivé pendant que le mode Argent Réel est actif — il ne doit jamais être utilisé pour simuler un vrai dépôt.",
            403,
          ),
        );
      }

      const numericAmount = Number(amount);
      const MAX_CREDIT_AMOUNT = 500000; // XAF, plafond par opération
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return next(new AppError('Montant invalide', 400));
      }
      if (numericAmount > MAX_CREDIT_AMOUNT) {
        return next(
          new AppError(
            `Le crédit manuel est plafonné à ${MAX_CREDIT_AMOUNT.toLocaleString()} XAF par opération.`,
            400,
          ),
        );
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        return next(new AppError('Un motif est requis pour créditer un portefeuille.', 400));
      }

      const targetUser = await User.findById(id);
      if (!targetUser) {
        return next(new AppError('Utilisateur non trouvé', 404));
      }

      const { WalletService } = await import('../services/walletService');
      const transaction = await WalletService.executeTransaction({
        userId: id,
        amount: numericAmount,
        type: 'deposit',
        paymentMethod: 'wallet',
        description: `Crédit test (mode simulation) par admin — ${reason.trim()}`,
        metadata: {
          isSimulationCredit: true,
          adminId: (req as any).user._id.toString(),
          reason: reason.trim(),
        },
      });

      AuditService.record(
        {
          userId: (req as any).user._id,
          action: 'WALLET_SIMULATION_CREDIT',
          resource: 'User',
          resourceId: id,
          newValue: { amount: numericAmount, reason: reason.trim() },
          status: 'success',
        },
        req,
      );

      const updatedUser = await User.findById(id).select('walletBalance currency');

      res.status(200).json({
        status: 'success',
        data: { transaction, walletBalance: updatedUser?.walletBalance },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Export rapide de conformité/reporting utilisé par la page Admin "Rapports
   * & Exports". Plafonné à 5000 documents par export pour éviter un dump
   * mémoire incontrôlé — pour un export complet, utiliser exportDatabase.
   */
  static async generateReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { type } = req.params;
      const REPORT_LIMIT = 5000;

      let data: any;
      switch (type) {
        case 'users':
          // .lean() bypasses the schema's toJSON transform (which normally
          // strips refreshToken/totpSecret for API responses), so those
          // fields must be excluded explicitly here even though password/
          // totpSecret/backupCodeHashes already carry `select: false`.
          data = await User.find()
            .select('-refreshToken -sessions.refreshToken -security.totpSecret -security.backupCodeHashes')
            .sort('-createdAt')
            .limit(REPORT_LIMIT)
            .lean();
          break;
        case 'transactions':
          data = await Transaction.find()
            .populate('userId', 'email firstName lastName country currency')
            .sort('-date')
            .limit(REPORT_LIMIT)
            .lean();
          break;
        case 'tontines':
          data = await Tontine.find()
            .populate('creatorId', 'firstName lastName email')
            .sort('-createdAt')
            .limit(REPORT_LIMIT)
            .lean();
          break;
        default:
          return next(new AppError('Type de rapport inconnu. Valeurs autorisées : users, transactions, tontines', 400));
      }

      AuditService.record(
        {
          userId: (req as any).user._id,
          action: 'REPORT_EXPORT',
          resource: type,
          status: 'success',
          metadata: { count: data.length },
        },
        req,
      );

      res.status(200).json({
        status: 'success',
        results: data.length,
        data,
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

      AuditService.record(
        {
          userId: (req as any).user._id,
          action: 'role' in updates ? 'USER_ROLE_CHANGE' : 'USER_UPDATE',
          resource: 'User',
          resourceId: id,
          newValue: updates,
          status: 'success',
        },
        req,
      );

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

  // Allowlist of comparison operators the "advanced filtering" query-string syntax
  // (e.g. ?amount[gte]=1000) is allowed to produce. Any other `$`-prefixed key —
  // $where, $expr, $function, or an operator injected via a raw query-string key
  // like ?$where=... (which `qs` parses straight into an object) — is stripped.
  // These admin list endpoints build their Mongo filter directly from req.query,
  // and are reachable by the lower-trust `support` role too, not just `admin`.
  private static readonly SAFE_QUERY_OPERATORS = new Set(['$gte', '$gt', '$lte', '$lt', '$ne', '$in']);

  private static sanitizeQueryObject(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((v) => AdminController.sanitizeQueryObject(v));
    }
    if (obj !== null && typeof obj === 'object') {
      const clean: any = {};
      for (const key of Object.keys(obj)) {
        if (key.startsWith('$') && !AdminController.SAFE_QUERY_OPERATORS.has(key)) {
          continue;
        }
        clean[key] = AdminController.sanitizeQueryObject(obj[key]);
      }
      return clean;
    }
    return obj;
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

      const safeQuery = AdminController.sanitizeQueryObject(JSON.parse(queryStr));

      const transactions = await Transaction.find(safeQuery)
        .populate('userId', 'email firstName lastName country currency')
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit);

      const total = await Transaction.countDocuments(safeQuery);

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

      // `key` becomes a Mongo filter/upsert field below, so it must be a
      // plain, safe identifier — reject anything that could be used for
      // prototype pollution (__proto__/constructor/prototype) or that isn't
      // a real setting key.
      const ALLOWED_GROUPS = [
        'general',
        'maintenance',
        'payment',
        'app_version',
        'legal',
        'app_info',
        'mobile',
      ];
      const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

      if (
        typeof key !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,100}$/.test(key) ||
        DANGEROUS_KEYS.includes(key)
      ) {
        return next(new AppError('Clé de paramètre invalide', 400));
      }
      if (group !== undefined && !ALLOWED_GROUPS.includes(group)) {
        return next(
          new AppError(`Groupe de paramètre invalide. Valeurs autorisées : ${ALLOWED_GROUPS.join(', ')}`, 400),
        );
      }
      if (value === undefined) {
        return next(new AppError('La valeur du paramètre est requise', 400));
      }

      // The real-money toggle is special-cased: it must go through
      // FeatureFlagService.setRealMoneyMode so the SystemSetting AND the
      // FeatureFlag document (which the public /config/features endpoint the
      // mobile app reads is built from) are updated together, atomically, with
      // a single notification broadcast — writing the SystemSetting directly
      // here would leave the FeatureFlag doc (and therefore the mobile app)
      // silently out of sync.
      if (key === 'real_money_mode') {
        const { FeatureFlagService } = await import('../services/featureFlagService');
        await FeatureFlagService.setRealMoneyMode(Boolean(value), (req as any).user._id);
        const setting = await SystemSetting.findOne({ key }).lean();
        return res.status(200).json({ status: 'success', data: setting });
      }

      const previous = await SystemSetting.findOne({ key }).lean();

      const setting = await SystemSetting.findOneAndUpdate(
        { key },
        { value, description, group, isPublic },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
      );

      // real_money_countries is embedded in the public /config/features
      // response (see FeatureFlagController.getPublicFeatures), which is
      // Redis-cached for up to an hour — without this, an admin narrowing or
      // widening the country allowlist would silently keep serving the old
      // list to the mobile app for up to an hour after saving.
      if (key === 'real_money_countries') {
        const { RedisService } = await import('../services/redisService');
        await RedisService.del('config:features');
      }

      AuditService.record(
        {
          userId: (req as any).user._id,
          action: 'SETTINGS_UPDATE',
          resource: 'SystemSetting',
          resourceId: key,
          oldValue: previous ? { value: previous.value, group: previous.group } : undefined,
          newValue: { value, group },
          status: 'success',
        },
        req,
      );

      res.status(200).json({ status: 'success', data: setting });
    } catch (error) {
      next(error);
    }
  }

  // --- HELPER FOR DOCKER RESOURCE MONITORING ---
  private static readCgroupValue(filePath: string): number | null {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        const value = parseInt(content, 10);
        return isNaN(value) || value <= 0 ? null : value;
      }
    } catch (error) {
      // Ignore errors (fallback to OS module)
    }
    return null;
  }

  private static getDockerResources() {
    // Memory (cgroup v1 / v2)
    const memLimit =
      AdminController.readCgroupValue('/sys/fs/cgroup/memory/memory.limit_in_bytes') || // v1
      AdminController.readCgroupValue('/sys/fs/cgroup/memory.max'); // v2

    const memUsage =
      AdminController.readCgroupValue('/sys/fs/cgroup/memory/memory.usage_in_bytes') || // v1
      AdminController.readCgroupValue('/sys/fs/cgroup/memory.current'); // v2

    // CPU (cgroup v1 / v2)
    let cpuCount: number | null = null;
    const cpuQuota =
      AdminController.readCgroupValue('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') || // v1
      AdminController.readCgroupValue('/sys/fs/cgroup/cpu.max'); // v2 (format: "quota period")

    const cpuPeriod =
      AdminController.readCgroupValue('/sys/fs/cgroup/cpu/cpu.cfs_period_us') || // v1
      100000; // Default period

    if (cpuQuota && cpuQuota > 0) {
      cpuCount = cpuQuota / cpuPeriod;
    }

    // Special case for cgroup v2 cpu.max which can contain "max 100000"
    try {
      if (fs.existsSync('/sys/fs/cgroup/cpu.max')) {
        const content = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ');
        if (content[0] !== 'max') {
          const quota = parseInt(content[0], 10);
          const period = parseInt(content[1], 10) || 100000;
          cpuCount = quota / period;
        }
      }
    } catch (e) {}

    return {
      memoryLimit: memLimit,
      memoryUsage: memUsage,
      cpuCount: cpuCount,
    };
  }

  // 10. Server Resource Monitoring
  static async getServerResources(req: Request, res: Response, next: NextFunction) {
    try {
      const docker = AdminController.getDockerResources();

      const totalMem = docker.memoryLimit || os.totalmem();
      const usedMem = docker.memoryUsage || os.totalmem() - os.freemem();
      const freeMem = totalMem - usedMem;

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
          count: docker.cpuCount || os.cpus().length,
          loadAvg: os.loadavg(), // [1, 5, 15] mins
        },
        os: {
          platform: os.platform(),
          release: os.release(),
          uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
          isDocker: !!(docker.memoryLimit || docker.cpuCount),
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
        redisInfo = info.split('\r\n').reduce((acc: any, line: string) => {
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

  // Fields to strip per collection when exporting via the raw driver (which bypasses
  // Mongoose's `select: false`) — password hashes, TOTP secrets/backup codes, and
  // refresh tokens must never leave the system in a bulk admin export.
  private static readonly EXPORT_EXCLUDED_FIELDS: Record<string, Record<string, 0>> = {
    users: {
      password: 0,
      'security.totpSecret': 0,
      'security.totpTempSecret': 0,
      'security.backupCodeHashes': 0,
      refreshToken: 0,
      'sessions.refreshToken': 0,
    },
  };

  static async exportDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      if (!mongoose.connection.db) {
        throw new AppError('Database connection not established', 500);
      }

      const collections = await mongoose.connection.db.listCollections().toArray();
      const exportData: Record<string, any[]> = {};

      for (const col of collections) {
        const projection = AdminController.EXPORT_EXCLUDED_FIELDS[col.name];
        const documents = await mongoose.connection.db
          .collection(col.name)
          .find({}, projection ? { projection } : undefined)
          .toArray();
        exportData[col.name] = documents;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `db_dump_${timestamp}.json`;

      AuditService.record({
        userId: (req as any).user._id,
        action: 'DB_EXPORT',
        resource: 'DATABASE',
        resourceId: filename,
        status: 'success',
        metadata: { collections: collections.map((c) => c.name) },
      });

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

      res.status(200).send(JSON.stringify(exportData, null, 2));
    } catch (error) {
      next(error);
    }
  }

  // --- TONTINE MANAGEMENT (ADMIN) ---
  static async getAllTontines(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const queryObj: any = { ...req.query };
      const excludedFields = ['page', 'sort', 'limit', 'fields', 'search'];
      excludedFields.forEach((el) => delete queryObj[el]);

      // Search functionality (regex metacharacters escaped to avoid a
      // pathological-pattern denial-of-service against the MongoDB server)
      if (req.query.search) {
        queryObj['name'] = {
          $regex: String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        };
      }

      const safeQuery = AdminController.sanitizeQueryObject(queryObj);

      const tontines = await Tontine.find(safeQuery)
        .populate('creatorId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await Tontine.countDocuments(safeQuery);

      res.status(200).json({
        status: 'success',
        results: tontines.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: tontines,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getTontineDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const tontine = await Tontine.findById(req.params.id)
        .populate('creatorId', 'firstName lastName email')
        .populate('members.userId', 'firstName lastName email avatar');

      if (!tontine) return next(new AppError('No tontine found with that ID', 404));

      res.status(200).json({ status: 'success', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  static async updateTontine(req: Request, res: Response, next: NextFunction) {
    try {
      // Admin can force update any field including status
      const tontine = await Tontine.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!tontine) return next(new AppError('No tontine found with that ID', 404));

      res.status(200).json({ status: 'success', data: tontine });
    } catch (error) {
      next(error);
    }
  }

  // --- SUBSCRIPTION MANAGEMENT (ADMIN) ---
  static async getAllSubscriptions(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const queryObj: any = { ...req.query };
      const excludedFields = ['page', 'sort', 'limit', 'fields', 'search'];
      excludedFields.forEach((el) => delete queryObj[el]);

      // Search functionality (regex metacharacters escaped — see getAllTontines)
      if (req.query.search) {
        queryObj['name'] = {
          $regex: String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        };
      }

      const safeQuery = AdminController.sanitizeQueryObject(queryObj);

      const subscriptions = await Subscription.find(safeQuery)
        .populate('userId', 'firstName lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await Subscription.countDocuments(safeQuery);

      res.status(200).json({
        status: 'success',
        results: subscriptions.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
        data: subscriptions,
      });
    } catch (error) {
      next(error);
    }
  }

  static async getSubscriptionDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const subscription = await Subscription.findById(req.params.id).populate(
        'userId',
        'firstName lastName email',
      );

      if (!subscription) return next(new AppError('No subscription found with that ID', 404));

      res.status(200).json({ status: 'success', data: subscription });
    } catch (error) {
      next(error);
    }
  }

  static async updateSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const subscription = await Subscription.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });

      if (!subscription) return next(new AppError('No subscription found with that ID', 404));

      res.status(200).json({ status: 'success', data: subscription });
    } catch (error) {
      next(error);
    }
  }

  // --- APP ANALYTICS DASHBOARD ---
  static async getAnalyticsDashboard(req: Request, res: Response, next: NextFunction) {
    try {
      const { period } = req.query; // 'day', 'week', 'month', 'year'

      let startDate = new Date();
      if (period === 'day') startDate.setDate(startDate.getDate() - 1);
      else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
      else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
      else if (period === 'year') startDate.setFullYear(startDate.getFullYear() - 1);
      else startDate.setDate(startDate.getDate() - 30); // Default 30 days

      // 1. Most Used Features
      const topFeatures = await UserActivity.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$feature', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]);

      // 2. Session Stats
      const sessionStats = await SessionLog.aggregate([
        { $match: { startTime: { $gte: startDate } } },
        {
          $group: {
            _id: null,
            avgDuration: { $avg: '$durationSeconds' },
            totalSessions: { $sum: 1 },
            uniqueUsers: { $addToSet: '$userId' },
          },
        },
        { $project: { avgDuration: 1, totalSessions: 1, uniqueUsers: { $size: '$uniqueUsers' } } },
      ]);

      // 3. Platform Distribution (active instances)
      const platformStats = await SessionLog.aggregate([
        { $match: { startTime: { $gte: startDate } } },
        { $group: { _id: '$platform', count: { $sum: 1 } } },
      ]);

      // 4. Daily Trends (DAU, New Users, Transactions)
      const dauTrend = await SessionLog.aggregate([
        { $match: { startTime: { $gte: startDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime' } },
            uniqueUsers: { $addToSet: '$userId' },
          },
        },
        {
          $project: {
            date: '$_id',
            count: { $size: '$uniqueUsers' },
            _id: 0,
          },
        },
        { $sort: { date: 1 } },
      ]);

      const newUserTrend = await User.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            date: '$_id',
            count: 1,
            _id: 0,
          },
        },
        { $sort: { date: 1 } },
      ]);

      const transactionTrend = await Transaction.aggregate([
        { $match: { date: { $gte: startDate } } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
              type: '$type',
            },
            count: { $sum: 1 },
            amount: { $sum: '$amount' },
          },
        },
        {
          $group: {
            _id: '$_id.date',
            types: {
              $push: {
                type: '$_id.type',
                count: '$count',
                amount: '$amount',
              },
            },
          },
        },
        {
          $project: {
            date: '$_id',
            types: 1,
            _id: 0,
          },
        },
        { $sort: { date: 1 } },
      ]);

      res.status(200).json({
        status: 'success',
        data: {
          period,
          topFeatures,
          sessionStats: sessionStats[0] || { avgDuration: 0, totalSessions: 0, uniqueUsers: 0 },
          platformStats,
          trends: {
            dau: dauTrend,
            newUsers: newUserTrend,
            transactions: transactionTrend,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

    // --- KYC REVIEW & MANAGEMENT ---
  static async getKycPendingUsers(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;
      const status = (req.query.status as string) || 'pending';
      const search = (req.query.search as string || '').trim();

      // Build status filter
      const query: any = {};
      if (status === 'pending') {
        query.kycLevel = 'pending';
      } else if (status === 'verified') {
        query.kycLevel = { $in: ['verified', 'tier1', 'tier2', 'approved'] };
      } else if (status === 'rejected') {
        query.kycLevel = 'rejected';
      } else if (status === 'all') {
        query.$or = [
          { kycLevel: { $in: ['pending', 'verified', 'tier1', 'tier2', 'rejected'] } },
          { 'kycData.documentImageUrl': { $exists: true, $ne: '' } },
        ];
      }

      // Add search filter
      if (search) {
        const regex = new RegExp(search, 'i');
        query.$and = query.$and || [];
        query.$and.push({
          $or: [
            { firstName: regex },
            { lastName: regex },
            { email: regex },
            { phone: regex },
            { 'kycData.documentNumber': regex },
            { 'kycData.fullName': regex },
          ],
        });
      }

      const [users, total, pendingCount, verifiedCount, rejectedCount, totalSubmissions] = await Promise.all([
        User.find(query)
          .select('firstName lastName email phone country kycLevel kycData createdAt updatedAt')
          .sort({ updatedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        User.countDocuments(query),
        User.countDocuments({ kycLevel: 'pending' }),
        User.countDocuments({ kycLevel: { $in: ['verified', 'tier1', 'tier2', 'approved'] } }),
        User.countDocuments({ kycLevel: 'rejected' }),
        User.countDocuments({
          $or: [
            { kycLevel: { $in: ['pending', 'verified', 'tier1', 'tier2', 'rejected'] } },
            { 'kycData.documentImageUrl': { $exists: true, $ne: '' } },
          ],
        }),
      ]);

      // Generate temporary signed URLs for private KYC documents
      const usersWithSignedDocs = await Promise.all(
        users.map(async (u: any) => {
          if (!u.kycData?.documentImageUrl && !u.kycData?.selfieImageUrl && !u.kycData?.documentBackImageUrl) {
            return u;
          }
          const signed = await KYCService.getSignedDocumentUrls(u._id.toString());
          return {
            ...u,
            kycData: {
              ...u.kycData,
              documentImageUrl: signed.documentUrl || u.kycData?.documentImageUrl,
              documentBackImageUrl: signed.documentBackUrl || u.kycData?.documentBackImageUrl,
              selfieImageUrl: signed.selfieUrl || u.kycData?.selfieImageUrl,
            },
          };
        }),
      );

      res.status(200).json({
        success: true,
        data: {
          users: usersWithSignedDocs,
          counts: {
            pending: pendingCount,
            verified: verifiedCount,
            rejected: rejectedCount,
            all: totalSubmissions,
          },
          pagination: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Modifier manuellement les informations KYC d'un utilisateur
  static async updateKycData(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { fullName, documentNumber, documentType, documentExpiryDate, kycLevel, rejectionReason } = req.body;

      const user = await User.findById(userId);
      if (!user) {
        return next(new AppError('Utilisateur non trouvé', 404));
      }

      if (!user.kycData) {
        (user as any).kycData = {};
      }

      const kycData = (user as any).kycData;
      if (fullName !== undefined) kycData.fullName = fullName;
      if (documentNumber !== undefined) kycData.documentNumber = documentNumber;
      if (documentType !== undefined) kycData.documentType = documentType;
      if (documentExpiryDate !== undefined) kycData.documentExpiryDate = documentExpiryDate;
      if (rejectionReason !== undefined) kycData.rejectionReason = rejectionReason;
      if (kycLevel !== undefined) user.kycLevel = kycLevel;

      await user.save();

      res.status(200).json({
        success: true,
        message: 'Dossier KYC mis à jour avec succès',
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  static async validateKyc(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const user = await KYCService.adminVerify(userId, 'verified');

      res.status(200).json({
        success: true,
        message: 'KYC validé avec succès',
        data: { kycLevel: user.kycLevel },
      });
    } catch (error) {
      next(error);
    }
  }

  
  static async revalidateKyc(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { reason } = req.body;
      const user = await KYCService.adminVerify(userId, 'update_required', reason || 'Mise à jour requise pour vos documents KYC');
      return res.status(200).json({
        success: true,
        message: 'Demande de mise à jour KYC transmise avec succès',
        data: { kycLevel: user.kycLevel, rejectionReason: user.kycData?.rejectionReason },
      });
    } catch (err) {
      return next(err);
    }
  }

  static async rejectKyc(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { reason } = req.body;
      const user = await KYCService.adminVerify(userId, 'rejected', reason);

      res.status(200).json({
        success: true,
        message: 'KYC rejeté',
        data: { kycLevel: user.kycLevel, rejectionReason: user.kycData?.rejectionReason },
      });
    } catch (error) {
      next(error);
    }
  }

  // --- WALLET LEDGER ---
  static async getWalletLedger(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const filter: any = {};
      if (typeof req.query.type === 'string') filter.type = req.query.type;
      if (typeof req.query.paymentMethod === 'string') filter.paymentMethod = req.query.paymentMethod;

      const [transactions, total] = await Promise.all([
        Transaction.find(filter)
          .populate('userId', 'firstName lastName email country')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Transaction.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        data: { transactions, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getUserWalletLedger(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const [transactions, total, user] = await Promise.all([
        Transaction.find({ userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Transaction.countDocuments({ userId }),
        User.findById(userId).select('firstName lastName email walletBalance currency kycLevel').lean(),
      ]);

      if (!user) throw new AppError('Utilisateur non trouvé', 404);

      res.status(200).json({
        success: true,
        data: { user, transactions, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } },
      });
    } catch (error) {
      next(error);
    }
  }

  // --- PAYOUTS ---
  static async getPayouts(req: Request, res: Response, next: NextFunction) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const skip = (page - 1) * limit;

      const filter: any = { type: 'withdrawal' };
      if (typeof req.query.status === 'string') filter.status = req.query.status;

      const [payouts, total] = await Promise.all([
        Payment.find(filter)
          .populate('userId', 'firstName lastName email country')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Payment.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        data: { payouts, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getPayoutDetails(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const payout = await Payment.findById(id).populate('userId', 'firstName lastName email country kycLevel').lean();
      if (!payout) throw new AppError('Retrait non trouvé', 404);

      res.status(200).json({ success: true, data: payout });
    } catch (error) {
      next(error);
    }
  }

  // Étape 1/2 du contrôle à deux mains : un admin DEMANDE la relance. Ne
  // touche pas encore au statut réel du paiement — une relance effective
  // nécessite l'approbation d'un second admin via approvePayoutRetry.
  static async retryPayout(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const requesterId = (req as any).user._id;

      // Atomic guard against two simultaneous retry requests on the same
      // payout — same reasoning as approvePayoutRetry/rejectPayoutRetry.
      const payout = await Payment.findOneAndUpdate(
        {
          _id: id,
          type: 'withdrawal',
          $or: [{ 'retryApproval.status': { $exists: false } }, { 'retryApproval.status': { $ne: 'pending_approval' } }],
        },
        {
          retryApproval: {
            status: 'pending_approval',
            requestedBy: requesterId,
            requestedAt: new Date(),
          },
        },
        { new: true },
      );

      if (!payout) {
        const existing = await Payment.findById(id);
        if (!existing) throw new AppError('Retrait non trouvé', 404);
        if (existing.type !== 'withdrawal') throw new AppError("Ce paiement n'est pas un retrait", 400);
        throw new AppError('Une demande de relance est déjà en attente d\'approbation', 400);
      }

      AuditService.record(
        {
          userId: requesterId,
          action: 'PAYOUT_RETRY_REQUESTED',
          resource: 'Payment',
          resourceId: id,
          metadata: { reference: payout.reference },
          status: 'success',
        },
        req,
      );

      res.status(200).json({
        success: true,
        message: "Demande de relance enregistrée — en attente de l'approbation d'un second administrateur",
      });
    } catch (error) {
      next(error);
    }
  }

  // Étape 2/2 : un SECOND admin (jamais celui qui a demandé la relance)
  // approuve — c'est seulement à ce moment que le statut repasse à
  // 'pending' et déclenche réellement une nouvelle tentative de transfert.
  static async approvePayoutRetry(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const approverId = (req as any).user._id;

      // findById-then-save left a check-then-act gap: two concurrent
      // approvals (or an approve racing a reject) could both read
      // 'pending_approval' before either write landed, and the second
      // .save() would silently overwrite the first. The status/requester
      // guard now lives in the filter of a single atomic findOneAndUpdate,
      // so only one concurrent request can ever match and succeed — the
      // other gets back `null` and a normal "nothing pending" error.
      const payout = await Payment.findOneAndUpdate(
        {
          _id: id,
          'retryApproval.status': 'pending_approval',
          'retryApproval.requestedBy': { $ne: approverId },
        },
        {
          status: 'pending',
          'retryApproval.status': 'approved',
          'retryApproval.approvedBy': approverId,
          'retryApproval.approvedAt': new Date(),
        },
        { new: true },
      );

      if (!payout) {
        // Distinguish "nothing pending" from "you requested this yourself"
        // only for the error message — the atomic filter above is what
        // actually enforces both, so this read can't be raced to bypass it.
        const existing = await Payment.findById(id).select('retryApproval');
        if (existing?.retryApproval?.status === 'pending_approval') {
          throw new AppError(
            'Un administrateur ne peut pas approuver sa propre demande de relance',
            403,
          );
        }
        throw new AppError('Aucune demande de relance en attente pour ce retrait', 400);
      }

      AuditService.record(
        {
          userId: approverId,
          action: 'PAYOUT_RETRY_APPROVED',
          resource: 'Payment',
          resourceId: id,
          metadata: {
            reference: payout.reference,
            requestedBy: payout.retryApproval?.requestedBy,
          },
          status: 'success',
        },
        req,
      );

      res.status(200).json({ success: true, message: 'Relance approuvée — statut réinitialisé à pending' });
    } catch (error) {
      next(error);
    }
  }

  static async rejectPayoutRetry(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const approverId = (req as any).user._id;

      // Same atomicity concern as approvePayoutRetry — see comment there.
      const payout = await Payment.findOneAndUpdate(
        { _id: id, 'retryApproval.status': 'pending_approval' },
        {
          'retryApproval.status': 'rejected',
          'retryApproval.approvedBy': approverId,
          'retryApproval.approvedAt': new Date(),
          'retryApproval.reason': reason,
        },
        { new: true },
      );
      if (!payout) {
        throw new AppError('Aucune demande de relance en attente pour ce retrait', 400);
      }

      AuditService.record(
        {
          userId: approverId,
          action: 'PAYOUT_RETRY_REJECTED',
          resource: 'Payment',
          resourceId: id,
          metadata: {
            reference: payout.reference,
            requestedBy: payout.retryApproval?.requestedBy,
            reason,
          },
          status: 'success',
        },
        req,
      );

      res.status(200).json({ success: true, message: 'Demande de relance rejetée' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Revoque toutes les sessions actives d'un utilisateur.
   * Utilise en cas de compte compromis ou de fraude detectee.
   */
  static async revokeUserSessions(req: any, res: any, next: any) {
    try {
      const { id } = req.params;

      // 1. Invalider tous les refresh tokens en Redis (pattern: refresh:userId:*)
      const redis = (await import('../config/redis')).default;
      const pattern = `refresh:${id}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }

      // 2. Marquer toutes les sessions en base comme revoquees
      const SessionLog = (await import('../models/SessionLog')).default;
      await SessionLog.updateMany(
        { userId: id, status: 'active' },
        { status: 'revoked', revokedAt: new Date(), revokedBy: req.user._id }
      );

      await (await import('../services/auditService')).AuditService.record({
        userId: req.user._id,
        action: 'USER_SESSIONS_REVOKED',
        resource: 'USER',
        resourceId: id,
        status: 'success',
        metadata: { revokedSessionsCount: keys.length },
      });

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
}