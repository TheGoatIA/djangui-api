import * as cron from 'node-cron';
import User from '../models/User';
import Budget from '../models/Budget';
import Transaction from '../models/Transaction';
import { NotificationService } from './notificationService';
import logger from '../utils/logger';
import mongoose from 'mongoose';

export class CronService {
    /**
     * Initialize all scheduled jobs
     */
    static init() {
        // Daily at 9:00 AM: Check for low balance
        cron.schedule('0 9 * * *', () => {
            this.checkLowBalances();
        });

        // Weekly on Monday at 8:00 AM: Financial summary
        cron.schedule('0 8 * * 1', () => {
            this.sendWeeklySummaries();
        });

        // Monthly on the 1st at 00:01 AM: Reset/Init budgets
        cron.schedule('1 0 1 * *', () => {
            this.autoInitMonthlyBudgets();
        });

        logger.info('Cron jobs initialized successfully');
    }

    /**
     * Send notifications to users with low wallet balance
     */
    private static async checkLowBalances() {
        try {
            const threshold = 1000; // Example threshold
            const users = await User.find({ walletBalance: { $lt: threshold }, isActive: true });

            for (const user of users) {
                await NotificationService.sendToUser(user._id.toString(), {
                    title: 'Solde bas ⚠️',
                    body: `Votre solde actuel est de ${user.walletBalance} ${user.currency}. Pensez à recharger votre portefeuille.`,
                    data: { type: 'LOW_BALANCE' }
                });
            }
            logger.info(`Low balance check completed for ${users.length} users`);
        } catch (error: any) {
            logger.error(`Error in checkLowBalances job: ${error.message}`);
        }
    }

    /**
     * Send a weekly summary of spending
     */
    private static async sendWeeklySummaries() {
        try {
            const now = new Date();
            const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const users = await User.find({ isActive: true });

            for (const user of users) {
                const stats = await Transaction.aggregate([
                    {
                        $match: {
                            userId: user._id,
                            date: { $gte: lastWeek },
                            type: 'expense'
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: '$amount' }
                        }
                    }
                ]);

                const totalSpent = stats.length > 0 ? stats[0].total : 0;

                await NotificationService.sendToUser(user._id.toString(), {
                    title: 'Votre résumé hebdo 📊',
                    body: `La semaine dernière, vous avez dépensé un total de ${totalSpent} ${user.currency}.`,
                    data: { type: 'WEEKLY_SUMMARY' }
                });
            }
            logger.info('Weekly summaries sent');
        } catch (error: any) {
            logger.error(`Error in sendWeeklySummaries job: ${error.message}`);
        }
    }

    /**
     * Automatically create a new budget for users for the new month based on the previous one
     */
    private static async autoInitMonthlyBudgets() {
        try {
            const now = new Date();
            const month = now.getMonth() + 1;
            const year = now.getFullYear();

            const prevMonth = month === 1 ? 12 : month - 1;
            const prevYear = month === 1 ? year - 1 : year;

            const users = await User.find({ isActive: true });

            for (const user of users) {
                const existingBudget = await Budget.findOne({ userId: user._id, 'period.month': month, 'period.year': year });
                if (existingBudget) continue;

                const lastBudget = await Budget.findOne({ userId: user._id, 'period.month': prevMonth, 'period.year': prevYear });

                if (lastBudget) {
                    // Clone previous budget categories but reset spent
                    const newCategories = lastBudget.categories.map(cat => ({
                        name: cat.name,
                        allocated: cat.allocated,
                        spent: 0,
                        percentage: 0
                    }));

                    await Budget.create({
                        userId: user._id,
                        period: { type: 'monthly', month, year },
                        categories: newCategories,
                        totalAllocated: lastBudget.totalAllocated,
                        totalSpent: 0,
                        status: 'active'
                    });
                }
            }
            logger.info('Monthly budgets initialized');
        } catch (error: any) {
            logger.error(`Error in autoInitMonthlyBudgets job: ${error.message}`);
        }
    }
}
