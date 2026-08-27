import * as cron from 'node-cron';
import User from '../models/User';
import Budget from '../models/Budget';
import Transaction from '../models/Transaction';
import { NotificationService } from './notificationService';
import logger from '../utils/logger';
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
import { SubscriptionService } from './subscriptionService';
import { SlackService } from './slackService';
import { MonitoringService } from './monitoringService';
import { ReconciliationService } from './reconciliationService';
import { NotchPayReconciliationService } from './notchpayReconciliationService';
import { FinancialAlertService } from './financialAlertService';
import { CurrencyService } from './currencyService';
import UserActivity from '../models/UserActivity';
import SharedSlot from '../models/SharedSlot';
import { ResellerNotificationDispatcher } from './resellerNotificationService';
import { ChallengeService } from './challengeService';

export class CronService {
  /**
   * Initialize all scheduled jobs
   */
  static init() {
    // Daily at 9:00 AM: Check for low balance
    cron.schedule(
      '0 9 * * *',
      this.runMonitored('low_balance_check', () => this.checkLowBalances()),
    );

    // Daily at 9:00 PM: Reminder to enter transactions
    cron.schedule(
      '0 21 * * *',
      this.runMonitored('transaction_reminder', () => this.sendDailyTransactionReminders()),
    );

    // Weekly on Monday at 8:00 AM: Financial summary
    cron.schedule(
      '0 8 * * 1',
      this.runMonitored('weekly_summary', () => this.sendWeeklySummaries()),
    );

    // Monthly on the 1st at 00:01 AM: Reset/Init budgets
    cron.schedule(
      '1 0 1 * *',
      this.runMonitored('monthly_budget_init', () => this.autoInitMonthlyBudgets()),
    );

    // Daily at midnight: Global Activity Report
    cron.schedule(
      '0 0 * * *',
      this.runMonitored('daily_admin_report', () => this.sendDailyAdminReport()),
    );

    // Daily at 03:00 AM: Financial Integrity Check
    cron.schedule(
      '0 3 * * *',
      this.runMonitored('integrity_check', () => this.runFinancialIntegrityCheck()),
    );

    // Daily at 03:15 AM: Currency exchange rate staleness check (USD/CAD are
    // hand-set approximations, not fixed pegs — see CurrencyService)
    cron.schedule(
      '15 3 * * *',
      this.runMonitored('currency_rate_staleness_check', async () => {
        CurrencyService.checkRatesStaleness();
      }),
    );

    // Monthly on the 1st at 04:00 AM: Data Archiving
    cron.schedule(
      '0 4 1 * *',
      this.runMonitored('data_archiving', () => this.runDataArchiving()),
    );

    // Daily at 10:00 AM: Inactivity Reminder (3 days)
    cron.schedule(
      '0 10 * * *',
      this.runMonitored('inactivity_check', () => this.checkUserInactivity()),
    );

    // Monthly on the 1st at 10:00 AM: Monthly Report Reminder
    cron.schedule(
      '0 10 1 * *',
      this.runMonitored('monthly_report_reminder', () => this.sendMonthlyReportReminders()),
    );

    // Daily at 11:00 AM: Overdraft Prevention (Premium)
    cron.schedule(
      '0 11 * * *',
      this.runMonitored('overdraft_prevention', () => this.runOverdraftPrevention()),
    );

    // Daily at 08:00 AM: Goal Progress Reminder
    cron.schedule(
      '0 8 * * *',
      this.runMonitored('goal_progress_reminder', () => this.sendDailyGoalProgress()),
    );

    // Daily at 11:00 AM: Personal AI Financial Advice
    cron.schedule(
      '0 11 * * *',
      this.runMonitored('ai_advice', () => this.sendDailyAIAdvice()),
    );

    // Daily at 10:00 AM: Tontine Payment Reminders
    cron.schedule(
      '0 10 * * *',
      this.runMonitored('tontine_payment_reminder', () => this.sendTontineReminders()),
    );

    // Daily at 09:00 AM: Subscription Reminders
    cron.schedule(
      '0 9 * * *',
      this.runMonitored('subscription_reminder', () => this.checkSubscriptionReminders()),
    );

    // Daily at 02:00 AM: Database Backup
    cron.schedule(
      '0 2 * * *',
      this.runMonitored('database_backup', () => this.runDailyBackup()),
    );

    // Daily at 01:00 AM: Automatic Subscription Renewals
    cron.schedule(
      '0 1 * * *',
      this.runMonitored('subscription_renewal', () => this.processSubscriptionsRenewal()),
    );

    // Daily at 00:05 AM: Premium Expirations
    cron.schedule(
      '5 0 * * *',
      this.runMonitored('premium_expiration', () => this.processPremiumExpirations()),
    );

    // Hourly: Tontine Health & Quality Check (Final Polish)
    cron.schedule(
      '0 * * * *',
      this.runMonitored('tontine_health_check', () => this.updateTontineHealthMetrics()),
    );

    // Every 10 minutes: Financial Pulse (Economy Gauge)
    cron.schedule(
      '*/10 * * * *',
      this.runMonitored('economy_pulse', () => this.updateEconomyMetrics()),
    );

    // Daily at 08:30 AM: Reseller Slot Reminders (J-3, J-0, Overdue)
    cron.schedule(
      '30 8 * * *',
      this.runMonitored('reseller_slot_reminders', () => this.checkResellerSlotReminders()),
    );

    // Daily at 00:15 AM: Reseller Slot Status Transitions (due_soon -> overdue -> blocked)
    cron.schedule(
      '15 0 * * *',
      this.runMonitored('reseller_slot_status_update', () => this.updateResellerSlotStatuses()),
    );

    // Daily at 02:00 AM: Tontine Auto-Debits
    cron.schedule(
      '0 2 * * *',
      this.runMonitored('tontine_auto_debit', () => TontineService.processAutoDebits()),
    );

    // Daily at 03:00 AM: Tontine Turn Rotation (pays out the current turn's winner and
    // advances currentTurn once its deadline + grace period has elapsed). Runs after
    // auto-debits so last-minute contributions are recorded before payout is computed.
    cron.schedule(
      '0 3 * * *',
      this.runMonitored('tontine_turn_rotation', () => this.rotateEligibleTontineTurns()),
    );

    // Daily at 04:00 AM: Global Reconciliation Check
    cron.schedule(
      '0 4 * * *',
      this.runMonitored('global_reconciliation', async () => {
        await ReconciliationService.checkInternalIntegrity();
      }),
    );

    // Every 30 minutes: check pending payments/transfers against NotchPay's
    // own records directly (not just Kauri's internal ledger against itself,
    // which is all the job above does) — self-heals a missed webhook instead
    // of leaving a payment stuck pending or a failed withdrawal unrefunded.
    cron.schedule(
      '*/30 * * * *',
      this.runMonitored('notchpay_reconciliation', async () => {
        await NotchPayReconciliationService.reconcile();
      }),
    );

    // Every 5 min: Update production metrics gauges (pending tx, daily volume, success rate)
    cron.schedule(
      '*/5 * * * *',
      this.runMonitored('metrics_gauge_update', () => this.updateProductionMetricsGauges()),
    );

    cron.schedule(
      '0 5 * * *',
      this.runMonitored('challenge_expiration', async () => {
        await ChallengeService.resolveExpiredChallenges();
      }),
    );

    // Run once on startup
    this.processSubscriptionsRenewal().catch((err) =>
      logger.error(`Startup renewal error: ${err.message}`),
    );
    this.processPremiumExpirations().catch((err) =>
      logger.error(`Startup premium expiration error: ${err.message}`),
    );
    this.updateEconomyMetrics().catch((err) =>
      logger.error(`Startup economy error: ${err.message}`),
    );

    logger.info('Cron jobs initialized successfully');
  }

  /**
   * Wrapper to monitor cron job execution
   */
  private static runMonitored(name: string, fn: () => Promise<void>) {
    return async () => {
      const start = Date.now();
      try {
        await fn();
        MonitoringService.recordCronJob(name, 'success');
        // Extended job metrics (additive)
        MonitoringService.recordBackgroundJob(name, 'success');
        MonitoringService.updateScheduledJobLastSuccess(name);
      } catch (error: any) {
        MonitoringService.recordCronJob(name, 'failure');
        MonitoringService.recordBackgroundJob(name, 'failure');
        MonitoringService.recordJobFailed(
          name,
          error.code || error.message?.slice(0, 50) || 'unknown',
        );
        logger.error(`Cron Job [${name}] failed: ${error.message}`);
      } finally {
        const duration = (Date.now() - start) / 1000;
        MonitoringService.observeCronJobDuration(name, duration);
        MonitoringService.observeBackgroundJobDuration(name, duration);
      }
    };
  }

  /**
   * Update gauges that require periodic MongoDB queries:
   * pending_transactions_gauge, daily_transaction_volume, transaction_success_rate
   */
  private static async updateProductionMetricsGauges() {
    try {
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Pending transactions by payment method (used as provider proxy)
      const pendingByProvider = await Transaction.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: { provider: '$paymentMethod' }, count: { $sum: 1 } } },
      ]);
      for (const row of pendingByProvider) {
        MonitoringService.updatePendingTransactions(row._id.provider || 'unknown', row.count);
      }

      // Daily transaction volume by currency
      const volumeByCurrency = await Transaction.aggregate([
        { $match: { status: 'completed', date: { $gte: since24h } } },
        { $group: { _id: '$currency', total: { $sum: '$amount' } } },
      ]);
      for (const row of volumeByCurrency) {
        MonitoringService.updateDailyTransactionVolume(row._id || 'XAF', row.total);
      }

      // Transaction success rate by payment method (last 24h)
      const ratioByProvider = await Transaction.aggregate([
        { $match: { date: { $gte: since24h }, paymentMethod: { $ne: 'cash' } } },
        {
          $group: {
            _id: '$paymentMethod',
            total: { $sum: 1 },
            success: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
      ]);
      for (const row of ratioByProvider) {
        if (row.total > 0) {
          MonitoringService.updateTransactionSuccessRate(
            row._id || 'unknown',
            'all',
            row.success / row.total,
          );
        }
      }
    } catch (error: any) {
      logger.error(`updateProductionMetricsGauges error: ${error.message}`);
    }
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
          title: '',
          body: '',
          translationKey: 'LOW_BALANCE',
          translationData: { balance: user.walletBalance, currency: user.currency },
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
        try {
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
            title: '',
            body: '',
            translationKey: 'WEEKLY_SUMMARY',
            translationData: { amount: totalSpent, currency: user.currency },
            data: { type: 'WEEKLY_SUMMARY' },
          });
        } catch (err: any) {
          logger.error(`Weekly summary failed for user ${user._id}: ${err.message}`);
        }
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
        try {
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
            // Suggestion d'objectif (Feature 4) : jamais de débit automatique du
            // wallet — juste une notification proposant à l'utilisateur de
            // contribuer lui-même le surplus non dépensé à l'objectif lié.
            // La contribution réelle ne se produit que si l'utilisateur confirme
            // via le flux GoalService.addContribution déjà existant.
            const surplus = lastBudget.totalAllocated - lastBudget.totalSpent;
            if (lastBudget.linkedGoalId && lastBudget.status !== 'exceeded' && surplus > 0) {
              const goal = await SavingGoal.findOne({
                _id: lastBudget.linkedGoalId,
                userId: user._id,
              }).select('name');
              if (goal) {
                NotificationService.sendToUser(user._id.toString(), {
                  title: '',
                  body: '',
                  translationKey: 'BUDGET_SURPLUS_GOAL_SUGGESTION',
                  translationData: { amount: surplus, goalName: goal.name },
                  data: {
                    type: 'budget_surplus_goal_suggestion',
                    goalId: goal._id.toString(),
                    amount: String(surplus),
                  },
                }).catch((err: any) =>
                  logger.error(`Budget surplus suggestion notification error: ${err.message}`),
                );
              }
            }

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
              linkedGoalId: lastBudget.linkedGoalId,
              // Cloned amounts are already in the previous budget's currency —
              // never assume XAF, that mislabels a non-XAF user's rollover budget.
              currency: lastBudget.currency || user.currency || 'XAF',
            });
          }
        } catch (err: any) {
          logger.error(`Monthly budget init failed for user ${user._id}: ${err.message}`);
        }
      }
      logger.info('Monthly budgets initialized');
    } catch (error: any) {
      logger.error(`Error in autoInitMonthlyBudgets job: ${error.message}`);
    }
  }

  /**
   * Send daily global activity report to admin (UPGRADED)
   */
  private static async sendDailyAdminReport() {
    try {
      const stats = await ReportService.getExecutiveFinancialReport('daily');

      // Utilisation du nouveau service d'alerting pour le rapport exécutif
      await FinancialAlertService.sendDailyExecutiveReport(stats);

      logger.info('Daily executive financial report sent');
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
          title: '',
          body: '',
          translationKey: 'DAILY_REMINDER_TRANSACTION',
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
        try {
          const lastTransaction = await Transaction.findOne({ userId: user._id })
            .sort({ date: -1 })
            .select('date');

          if (!lastTransaction || lastTransaction.date < threeDaysAgo) {
            await NotificationService.sendToUser(user._id.toString(), {
              title: '',
              body: '',
              translationKey: 'INACTIVITY_REMINDER',
              data: { type: 'INACTIVITY_REMINDER' },
            });
          }
        } catch (err: any) {
          logger.error(`Inactivity check failed for user ${user._id}: ${err.message}`);
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
          title: '',
          body: '',
          translationKey: 'MONTHLY_REPORT_READY',
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
          title: '',
          body: '',
          translationKey: 'GOAL_DAILY_PROGRESS',
          translationData: { goalName: goal.name, progress: goal.progress.toFixed(1) },
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
        try {
          // We call the service to get the forecast
          const result = await ForecastService.getBalanceForecast(user._id.toString());

          if (result?.criticalAlert) {
            await NotificationService.sendToUser(user._id.toString(), {
              title: '',
              body: '',
              translationKey: 'TREASURY_ALERT',
              translationData: { firstName: user.firstName, alert: result.criticalAlert },
              data: { type: 'OVERDRAFT_PREVENTION' },
            });
          }
        } catch (err: any) {
          logger.error(`Overdraft prevention failed for user ${user._id}: ${err.message}`);
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
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

      // Identify active IDs from actions or transactions
      const [activityUserIds, transactionUserIds] = await Promise.all([
        UserActivity.distinct('userId', { createdAt: { $gte: fiveDaysAgo } }),
        Transaction.distinct('userId', { createdAt: { $gte: fiveDaysAgo } }),
      ]);

      const activeIds = [...new Set([...activityUserIds, ...transactionUserIds])];
      const users = await User.find({ _id: { $in: activeIds }, isActive: true });

      logger.info(
        `Starting daily AI advice generation for ${users.length} active users (from ${activeIds.length} candidate IDs)`,
      );

      let successCount = 0;
      for (const user of users) {
        try {
          const advice = await CoachService.generateDailyAdvice(user._id.toString());
          await NotificationService.sendToUser(user._id.toString(), {
            title: advice.title,
            body: advice.body,
            data: { type: 'DAILY_AI_ADVICE' },
          });
          successCount++;
        } catch (err: any) {
          logger.error(`Failed to send daily advice to user ${user._id}: ${err.message}`);
        }
      }

      // Slack Summary Notification
      await SlackService.sendNotification(
        `🔄 *AI Daily Advice* : Généré avec succès pour ${successCount} utilisateurs ayant réalisé des actions significatives ces 5 derniers jours.`,
      );

      logger.info(
        `Daily AI advice job completed. Processed ${successCount}/${users.length} users.`,
      );
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
        try {
          // Calculate deadline for current turn
          const deadline = TontineService.getTurnDeadline(
            tontine.startDate,
            tontine.frequency,
            tontine.currentTurn,
          );

          // If deadline is tomorrow (within 24-48h window for once-a-day check)
          const diffHours = (deadline.getTime() - Date.now()) / 3600000;

          if (diffHours > 0 && diffHours <= 24) {
            // Find members who haven't paid for this turn
            const members = await TontineMember.find({
              tontineId: tontine._id,
              invitationStatus: 'accepted',
            });

            for (const member of members) {
              try {
                const hasPaid = await TontineContribution.findOne({
                  tontineId: tontine._id,
                  memberId: member._id,
                  turnIndex: tontine.currentTurn,
                  validationStatus: { $in: ['ai_validated', 'completed'] },
                });

                if (!hasPaid) {
                  await NotificationService.sendToUser(member.userId.toString(), {
                    title: '',
                    body: '',
                    translationKey: 'TONTINE_PAYMENT_REMINDER',
                    translationData: { turn: tontine.currentTurn, tontineName: tontine.name },
                    data: { tontineId: tontine._id.toString(), type: 'TONTINE_REMINDER' },
                  });
                }
              } catch (err: any) {
                logger.error(
                  `Tontine reminder failed for member ${member._id} (tontine ${tontine._id}): ${err.message}`,
                );
              }
            }
          }
        } catch (err: any) {
          logger.error(`Tontine reminder check failed for tontine ${tontine._id}: ${err.message}`);
        }
      }
      logger.info(`Tontine reminders check completed for ${activeTontines.length} active tontines`);
    } catch (error: any) {
      logger.error(`Error in sendTontineReminders job: ${error.message}`);
    }
  }

  /**
   * Rotate the turn (and trigger the winner's payout) for every active tontine whose
   * current turn deadline + grace period has already elapsed. Without this job,
   * `currentTurn` never advances and `TontineService.rotateTurn` is dead code — turns
   * would never actually complete or pay out in production.
   */
  private static async rotateEligibleTontineTurns() {
    let rotatedCount = 0;
    try {
      const activeTontines = await Tontine.find({ status: 'active' });

      for (const tontine of activeTontines) {
        const deadline = TontineService.getTurnDeadline(
          tontine.startDate,
          tontine.frequency,
          tontine.currentTurn,
        );
        const graceDeadline = new Date(
          deadline.getTime() + tontine.sanctions.gracePeriodHours * 3600000,
        );

        if (new Date() > graceDeadline) {
          try {
            // Pénalise les absents avant de figer le pot du tour, sinon un
            // membre qui n'a jamais payé échapperait à toute sanction (V-04).
            await TontineService.applyAbsenceFees(tontine._id.toString());
            await TontineService.rotateTurn(tontine._id.toString());
            rotatedCount++;
          } catch (err: any) {
            logger.error(`Tontine turn rotation failed for ${tontine._id}: ${err.message}`);
          }
        }
      }

      logger.info(
        `Tontine turn rotation check completed. Rotated ${rotatedCount}/${activeTontines.length} active tontines.`,
      );
    } catch (error: any) {
      logger.error(`Error in rotateEligibleTontineTurns job: ${error.message}`);
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
          title: '',
          body: '',
          translationKey: 'SUBSCRIPTION_REMINDER',
          translationData: { name: sub.name, amount: sub.amount, currency: sub.currency },
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
          title: '',
          body: '',
          translationKey: 'TRIAL_END_REMINDER',
          translationData: { name: sub.name },
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

  /**
   * Process automatic subscription renewals for those that reached their billing date
   */
  private static async processSubscriptionsRenewal() {
    try {
      logger.info('Starting automatic subscription renewal job...');
      const renewed = await SubscriptionService.processAutoRenewals();

      if (renewed.length > 0) {
        let slackMessage = `🔄 *Automatic Subscription Renewals*\n`;
        slackMessage += `Total renewed: ${renewed.length}\n\n`;

        renewed.forEach((sub) => {
          slackMessage += `• *${sub.name}*: ${sub.amount} ${sub.currency} (User: ${sub.userId})\n`;
        });

        await SlackService.sendNotification(slackMessage);
      }

      logger.info(
        `Automatic subscription renewal job completed. ${renewed.length} subscriptions renewed.`,
      );
    } catch (error: any) {
      logger.error(`Error in processSubscriptionsRenewal job: ${error.message}`);
    }
  }

  /**
   * Process premium status expirations
   */
  private static async processPremiumExpirations() {
    try {
      logger.info('Starting premium expiration job...');
      const count = await SubscriptionService.processPremiumExpirations();
      logger.info(`Premium expiration job completed. ${count} users moved to expired status.`);
    } catch (error: any) {
      logger.error(`Error in processPremiumExpirations job: ${error.message}`);
    }
  }

  /**
   * Calculate total AUM (Assets Under Management) for the Economy Gauge
   */
  private static async updateEconomyMetrics() {
    try {
      // 1. Total Wallet Balance
      const walletStats = await User.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$currency', total: { $sum: '$walletBalance' } } },
      ]);

      // 2. Total Savings in Goals
      const goalStats = await SavingGoal.aggregate([
        { $match: { status: 'active' } }, // Only active goals count towards AUM
        { $group: { _id: 'XAF', total: { $sum: '$currentAmount' } } }, // Goals are typically XAF for now, but safer to group if we had currency
      ]);

      // Update Gauge for each currency found
      walletStats.forEach((stat) => {
        MonitoringService.updateEconomyMetrics(stat.total, 0, stat._id || 'XAF');
      });

      if (goalStats.length > 0) {
        // Assuming Goals are XAF for this iteration, or we'd need currency on Goal model explicit check
        // For now, we update the Savings part
        MonitoringService.updateEconomyMetrics(0, goalStats[0].total, 'XAF');
      }

      logger.info('Economy metrics updated (Financial Pulse)');
    } catch (error: any) {
      logger.error(`Error in updateEconomyMetrics job: ${error.message}`);
    }
  }

  /**
   * Monitor Tontine Risk & Quality (Final Polish)
   */
  private static async updateTontineHealthMetrics() {
    try {
      // 1. Get Default Rate from Service
      const stats = await TontineService.getGlobalStats();
      const defaultRate = stats.lateRate || 0;

      // 2. Calculate Average Trust Score
      const trustStats = await TontineMember.aggregate([
        { $match: { invitationStatus: 'accepted' } },
        {
          $group: {
            _id: null,
            avgTrust: { $avg: '$trustScore' },
          },
        },
      ]);
      const avgTrust = trustStats.length > 0 ? trustStats[0].avgTrust : 100;

      // 3. Update Metrics
      MonitoringService.updateTontineHealth(defaultRate, avgTrust);

      logger.info(
        `Tontine Health updated: Default Rate=${defaultRate.toFixed(2)}%, Avg Trust=${avgTrust.toFixed(1)}`,
      );
    } catch (error: any) {
      logger.error(`Error in updateTontineHealthMetrics job: ${error.message}`);
    }
  }

  /**
   * Check upcoming and overdue reseller slots and dispatch reminders
   */
  private static async checkResellerSlotReminders() {
    try {
      const now = new Date();
      const in3DaysStart = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const in3DaysEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      // 1. J-3 Reminders
      const jMinus3Slots = await SharedSlot.find({
        status: { $in: ['active', 'due_soon'] },
        currentPeriodEnd: { $gte: in3DaysStart, $lte: in3DaysEnd },
        autoSendReminders: true,
      });

      for (const slot of jMinus3Slots) {
        await ResellerNotificationDispatcher.dispatch(slot, 'J-3');
      }

      // 2. J-0 Reminders
      const jZeroSlots = await SharedSlot.find({
        status: { $in: ['active', 'due_soon'] },
        currentPeriodEnd: { $gte: todayStart, $lte: todayEnd },
        autoSendReminders: true,
      });

      for (const slot of jZeroSlots) {
        await ResellerNotificationDispatcher.dispatch(slot, 'J-0');
      }

      logger.info(
        `Reseller slot reminders check completed: ${jMinus3Slots.length} (J-3), ${jZeroSlots.length} (J-0)`,
      );
    } catch (error: any) {
      logger.error(`Error in checkResellerSlotReminders job: ${error.message}`);
    }
  }

  /**
   * Daily transition of slot statuses (active -> due_soon -> overdue -> blocked)
   */
  private static async updateResellerSlotStatuses() {
    try {
      const now = new Date();
      const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      // 1. Mark due_soon
      await SharedSlot.updateMany(
        {
          status: 'active',
          currentPeriodEnd: { $lte: in3Days, $gt: now },
        },
        { $set: { status: 'due_soon' } },
      );

      // 2. Mark overdue
      await SharedSlot.updateMany(
        {
          status: { $in: ['active', 'due_soon'] },
          currentPeriodEnd: { $lte: now },
        },
        { $set: { status: 'overdue' } },
      );

      // 3. Mark blocked (if grace period exceeded)
      const overdueSlots = await SharedSlot.find({ status: 'overdue' });
      for (const slot of overdueSlots) {
        const graceDeadline = new Date(
          new Date(slot.currentPeriodEnd).getTime() + (slot.gracePeriodDays || 2) * 24 * 60 * 60 * 1000,
        );
        if (now > graceDeadline) {
          slot.status = 'blocked';
          await slot.save();
        }
      }

      logger.info('Reseller slot statuses updated successfully');
    } catch (error: any) {
      logger.error(`Error in updateResellerSlotStatuses job: ${error.message}`);
    }
  }
}
