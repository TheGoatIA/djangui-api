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
import { ForecastService } from './ai/forecastService';
import { CoachService } from './ai/coachService';
import SavingGoal from '../models/SavingGoal';
import Tontine from '../models/Tontine';
import TontineMember from '../models/TontineMember';
import TontineContribution from '../models/TontineContribution';
import { TontineService } from './tontineService';
import Subscription from '../models/Subscription';
import { SlackService } from './slackService';

export class CronService {
  /**
   * Initialize all scheduled jobs
   */
  static init() {
    // Daily at 9:00 AM: Check for low balance
    cron.schedule('0 9 * * *', () => {
      this.checkLowBalances();
    });

    // Daily at 9:00 PM: Reminder to enter transactions
    cron.schedule('0 21 * * *', () => {
      this.sendDailyTransactionReminders();
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

    // Daily at 10:00 AM: Inactivity Reminder (3 days)
    cron.schedule('0 10 * * *', () => {
      this.checkUserInactivity();
    });

    // Monthly on the 1st at 10:00 AM: Monthly Report Reminder
    cron.schedule('0 10 1 * *', () => {
      this.sendMonthlyReportReminders();
    });

    // Daily at 11:00 AM: Overdraft Prevention (Premium)
    cron.schedule('0 11 * * *', () => {
      this.runOverdraftPrevention();
    });

    // Daily at 08:00 AM: Goal Progress Reminder
    cron.schedule('0 8 * * *', () => {
      this.sendDailyGoalProgress();
    });

    // Daily at 11:00 AM: Personal AI Financial Advice
    cron.schedule('0 11 * * *', () => {
      this.sendDailyAIAdvice();
    });

    // Daily at 10:00 AM: Tontine Payment Reminders
    cron.schedule('0 10 * * *', () => {
      this.sendTontineReminders();
    });

    // Daily at 09:00 AM: Subscription Reminders
    cron.schedule('0 9 * * *', () => {
      this.checkSubscriptionReminders();
    });

    // Daily at 02:00 AM: Database Backup
    cron.schedule('0 2 * * *', () => {
      this.runDailyBackup();
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

      // Notify Slack
      await SlackService.sendNotification(
        `📊 *Daily Activity Report Ready*\n*Period*: ${stats.period.start.toLocaleDateString()}\n*New Users*: ${stats.users.new}\n*Active Users*: ${stats.users.active}\n*Income Volume*: ${stats.transactions.income.volume}\n*Expense Volume*: ${stats.transactions.expense.volume}`,
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

  /**
   * Send daily reminders to enter transactions at 21h
   */
  private static async sendDailyTransactionReminders() {
    try {
      const users = await User.find({ isActive: true });

      for (const user of users) {
        await NotificationService.sendToUser(user._id.toString(), {
          title: 'Pensée du soir 🌙',
          body: 'As-tu noté toutes tes dépenses et revenus aujourd’hui ? Prends 1 minute pour garder tes finances à jour !',
          data: { type: 'DAILY_REMINDER' },
        });
      }
      logger.info(`Daily transaction reminders sent to ${users.length} users`);
    } catch (error: any) {
      logger.error(`Error in sendDailyTransactionReminders job: ${error.message}`);
    }
  }

  /**
   * Check for users who haven't logged any transaction in the last 3 days
   */
  private static async checkUserInactivity() {
    try {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      // Find active users who have no transactions since 3 days ago
      const inactiveUsers = await User.find({ isActive: true });

      for (const user of inactiveUsers) {
        const lastTransaction = await Transaction.findOne({ userId: user._id })
          .sort({ date: -1 })
          .select('date');

        if (!lastTransaction || lastTransaction.date < threeDaysAgo) {
          await NotificationService.sendToUser(user._id.toString(), {
            title: 'Tu nous manques ! 👋',
            body: "Ça fait 3 jours que tu n'as rien noté. Reviens faire un point sur tes finances !",
            data: { type: 'INACTIVITY_REMINDER' },
          });
        }
      }
      logger.info('Inactivity check completed');
    } catch (error: any) {
      logger.error(`Error in checkUserInactivity job: ${error.message}`);
    }
  }

  /**
   * Remind users to check their monthly narrative report on the 1st
   */
  private static async sendMonthlyReportReminders() {
    try {
      const users = await User.find({ isActive: true });
      for (const user of users) {
        await NotificationService.sendToUser(user._id.toString(), {
          title: 'Ton Bilan Mensuel est prêt ! 📊',
          body: 'Découvre ton rapport narratif IA pour voir comment tu as géré tes finances le mois dernier.',
          data: { type: 'MONTHLY_REPORT_REMINDER' },
        });
      }
      logger.info('Monthly report reminders sent');
    } catch (error: any) {
      logger.error(`Error in sendMonthlyReportReminders job: ${error.message}`);
    }
  }

  /**
   * Send daily progress updates for active goals
   */
  private static async sendDailyGoalProgress() {
    try {
      const activeGoals = await SavingGoal.find({ status: 'active', progress: { $lt: 100 } });

      for (const goal of activeGoals) {
        await NotificationService.sendToUser(goal.userId.toString(), {
          title: `Objectif : ${goal.name} 📈`,
          body: `Tu es à ${goal.progress.toFixed(1)}% de ton objectif ! Un petit effort aujourd'hui ?`,
          data: { type: 'GOAL_DAILY_PROGRESS', goalId: goal._id.toString() },
        });
      }
      logger.info(`Daily goal progress sent for ${activeGoals.length} goals`);
    } catch (error: any) {
      logger.error(`Error in sendDailyGoalProgress job: ${error.message}`);
    }
  }

  /**
   * Proactive overdraft prevention based on forecast (Premium Only)
   */
  private static async runOverdraftPrevention() {
    try {
      const premiumUsers = await User.find({
        'subscription.plan': 'premium',
        'subscription.status': 'active',
        isActive: true,
      });

      for (const user of premiumUsers) {
        // We call the service to get the forecast
        const result = await ForecastService.getBalanceForecast(user._id.toString());

        if (result && result.criticalAlert) {
          await NotificationService.sendToUser(user._id.toString(), {
            title: 'Alerte Trésorerie ! ⚠️',
            body: `Attention ${user.firstName}, une analyse montre un risque de solde négatif bientôt : ${result.criticalAlert}`,
            data: { type: 'OVERDRAFT_PREVENTION' },
          });
        }
      }
      logger.info(`Overdraft prevention job completed for ${premiumUsers.length} premium users`);
    } catch (error: any) {
      logger.error(`Error in runOverdraftPrevention job: ${error.message}`);
    }
  }

  /**
   * Generate and send daily AI-powered financial advice
   */
  private static async sendDailyAIAdvice() {
    try {
      const users = await User.find({ isActive: true });
      logger.info(`Starting daily AI advice generation for ${users.length} users`);

      for (const user of users) {
        try {
          const advice = await CoachService.generateDailyAdvice(user._id.toString());
          await NotificationService.sendToUser(user._id.toString(), {
            title: advice.title,
            body: advice.body,
            data: { type: 'DAILY_AI_ADVICE' },
          });
        } catch (err: any) {
          logger.error(`Failed to send daily advice to user ${user._id}: ${err.message}`);
        }
      }
      logger.info('Daily AI advice job completed');
    } catch (error: any) {
      logger.error(`Error in sendDailyAIAdvice job: ${error.message}`);
    }
  }

  /**
   * Send reminders for tontine payments 24h before deadline
   */
  private static async sendTontineReminders() {
    try {
      const activeTontines = await Tontine.find({ status: 'active' });
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      for (const tontine of activeTontines) {
        // Calculate deadline for current turn
        const deadline = TontineService.getTurnDeadline(
          tontine.startDate,
          tontine.frequency,
          tontine.currentTurn,
        );

        // If deadline is tomorrow (within 24-48h window for once-a-day check)
        const diffHours = (deadline.getTime() - new Date().getTime()) / 3600000;

        if (diffHours > 0 && diffHours <= 24) {
          // Find members who haven't paid for this turn
          const members = await TontineMember.find({
            tontineId: tontine._id,
            invitationStatus: 'accepted',
          });

          for (const member of members) {
            const hasPaid = await TontineContribution.findOne({
              tontineId: tontine._id,
              memberId: member._id,
              turnIndex: tontine.currentTurn,
              validationStatus: { $in: ['ai_validated', 'completed'] },
            });

            if (!hasPaid) {
              await NotificationService.sendToUser(member.userId.toString(), {
                title: 'Rappel Tontine 🔔',
                body: `Demain est l'échéance pour le tour ${tontine.currentTurn} de "${tontine.name}". N'oubliez pas votre cotisation !`,
                data: { tontineId: tontine._id.toString(), type: 'TONTINE_REMINDER' },
              });
            }
          }
        }
      }
      logger.info(`Tontine reminders check completed for ${activeTontines.length} active tontines`);
    } catch (error: any) {
      logger.error(`Error in sendTontineReminders job: ${error.message}`);
    }
  }

  /**
   * Check for upcoming subscriptions and trials ending
   */
  private static async checkSubscriptionReminders() {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const inTwoDays = new Date();
      inTwoDays.setDate(inTwoDays.getDate() + 2);

      // 1. Reminders for normal subscriptions (24h before)
      const upcomingSubs = await Subscription.find({
        status: 'active',
        remindMe: true,
        nextBillingDate: {
          $gte: new Date(),
          $lte: tomorrow,
        },
      });

      for (const sub of upcomingSubs) {
        await NotificationService.sendToUser(sub.userId.toString(), {
          title: `Rappel Abonnement 💳`,
          body: `Demain, votre abonnement "${sub.name}" sera prélevé (${sub.amount} ${sub.currency}).`,
          data: { type: 'SUBSCRIPTION_REMINDER', subscriptionId: sub._id.toString() },
        });
      }

      // 2. Trial End Reminders (48h before - Revolutionary feature)
      const trialEnds = await Subscription.find({
        status: 'active',
        trialEndDate: {
          $gte: new Date(),
          $lte: inTwoDays,
        },
      });

      for (const sub of trialEnds) {
        await NotificationService.sendToUser(sub.userId.toString(), {
          title: `Alerte Fin d'Essai ! 🚨`,
          body: `Votre période d'essai pour "${sub.name}" se termine dans 48h. Pensez à l'annuler si vous ne souhaitez pas être prélevé.`,
          data: { type: 'TRIAL_END_REMINDER', subscriptionId: sub._id.toString() },
        });
      }

      logger.info(
        `Subscription reminders sent: ${upcomingSubs.length} subs, ${trialEnds.length} trials`,
      );
    } catch (error: any) {
      logger.error(`Error in checkSubscriptionReminders job: ${error.message}`);
    }
  }
}
