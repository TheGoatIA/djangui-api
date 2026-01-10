import * as cron from 'node-cron';
import User from '../models/User';
import Budget from '../models/Budget';
import Transaction from '../models/Transaction';
import { NotificationService } from './notificationService';
import logger from '../utils/logger';
import mongoose from 'mongoose';
import { DbBackupService } from './dbBackupService';
import { ReportService } from './reportService';
import { EmailService } from './emailService';
import { ArchiveService } from './archiveService';

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

    // Daily at midnight: Global Activity Report
    cron.schedule('0 0 * * *', () => {
      this.sendDailyAdminReport();
    });

    // Daily at 03:00 AM: Financial Integrity Check
    cron.schedule('0 3 * * *', () => {
      this.runFinancialIntegrityCheck();
    });

    // Monthly on the 1st at 04:00 AM: Data Archiving
    cron.schedule('0 4 1 * *', () => {
      this.runDataArchiving();
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
          data: { type: 'LOW_BALANCE' },
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
              type: 'expense',
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amount' },
            },
          },
        ]);

        const totalSpent = stats.length > 0 ? stats[0].total : 0;

        await NotificationService.sendToUser(user._id.toString(), {
          title: 'Votre résumé hebdo 📊',
          body: `La semaine dernière, vous avez dépensé un total de ${totalSpent} ${user.currency}.`,
          data: { type: 'WEEKLY_SUMMARY' },
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
        const existingBudget = await Budget.findOne({
          userId: user._id,
          'period.month': month,
          'period.year': year,
        });
        if (existingBudget) continue;

        const lastBudget = await Budget.findOne({
          userId: user._id,
          'period.month': prevMonth,
          'period.year': prevYear,
        });

        if (lastBudget) {
          // Clone previous budget categories but reset spent
          const newCategories = lastBudget.categories.map((cat) => ({
            name: cat.name,
            allocated: cat.allocated,
            spent: 0,
            percentage: 0,
          }));

          await Budget.create({
            userId: user._id,
            period: { type: 'monthly', month, year },
            categories: newCategories,
            totalAllocated: lastBudget.totalAllocated,
            totalSpent: 0,
            status: 'active',
          });
        }
      }
      logger.info('Monthly budgets initialized');
    } catch (error: any) {
      logger.error(`Error in autoInitMonthlyBudgets job: ${error.message}`);
    }
  }

  /**
   * Send daily global activity report to admin
   */
  private static async sendDailyAdminReport() {
    try {
      const stats = await ReportService.getGlobalDailyStats();
      const adminEmail = process.env.ADMIN_EMAIL || 'me@borisgauty.com';

      const html = `
        <h3>Rapport d'Activité Journalier</h3>
        <p><strong>Période :</strong> ${stats.period.start.toLocaleString()} - ${stats.period.end.toLocaleString()}</p>
        
        <h4>Utilisateurs</h4>
        <ul>
          <li>Nouveaux : ${stats.users.new}</li>
          <li>Actifs (24h) : ${stats.users.active}</li>
        </ul>

        <h4>Transactions</h4>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f2f2f2;">
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Type</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Nombre</th>
              <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Volume Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd;">Revenus</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${stats.transactions.income.count}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${stats.transactions.income.volume}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd;">Dépenses</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${stats.transactions.expense.count}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${stats.transactions.expense.volume}</td>
            </tr>
          </tbody>
        </table>
      `;

      await EmailService.sendEmail(
        adminEmail,
        `📊 Rapport Journalier KAURI - ${new Date().toLocaleDateString()}`,
        'Votre rapport quotidien est prêt.',
        html,
      );
      logger.info('Daily admin report sent');
    } catch (error: any) {
      logger.error(`Error in sendDailyAdminReport job: ${error.message}`);
    }
  }

  /**
   * Run daily database backup
   */
  private static async runDailyBackup() {
    try {
      await DbBackupService.runBackup();
      logger.info('Daily database backup job completed');
    } catch (error: any) {
      logger.error(`Error in runDailyBackup job: ${error.message}`);
    }
  }

  /**
   * Run financial integrity check and alert if anomalies found
   */
  private static async runFinancialIntegrityCheck() {
    try {
      const anomalies = await ReportService.checkFinancialIntegrity();
      if (anomalies.length > 0) {
        const adminEmail = process.env.ADMIN_EMAIL || 'me@borisgauty.com';
        const html = `
          <h3>Alerte : Anomalies de Portefeuille Détectées</h3>
          <p>Le script de réconciliation a trouvé ${anomalies.length} utilisateurs avec un solde incohérent.</p>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background-color: #f2f2f2;">
                <th style="padding: 8px; border: 1px solid #ddd;">Email</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Solde Réel</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Solde Calculé</th>
                <th style="padding: 8px; border: 1px solid #ddd;">Différence</th>
              </tr>
            </thead>
            <tbody>
              ${anomalies
                .map(
                  (a) => `
                <tr>
                  <td style="padding: 8px; border: 1px solid #ddd;">${a.email}</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${a.walletBalance}</td>
                  <td style="padding: 8px; border: 1px solid #ddd;">${a.calculatedBalance}</td>
                  <td style="padding: 8px; border: 1px solid #ddd; color: red;">${a.diff.toFixed(2)}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        `;

        await EmailService.sendEmail(
          adminEmail,
          `🚨 ANOMALIE FINANCIÈRE - ${new Date().toLocaleDateString()}`,
          'Des écarts de solde ont été détectés.',
          html,
        );
      }
    } catch (error: any) {
      logger.error(`Error in runFinancialIntegrityCheck job: ${error.message}`);
    }
  }

  /**
   * Run data archiving job
   */
  private static async runDataArchiving() {
    try {
      await ArchiveService.runArchiving();
      logger.info('Monthly data archiving job completed');
    } catch (error: any) {
      logger.error(`Error in runDataArchiving job: ${error.message}`);
    }
  }
}
