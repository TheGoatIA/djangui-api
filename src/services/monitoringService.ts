import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class MonitoringService {
  private static registry = new client.Registry();

  // Metrics definitions
  private static httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 10],
  });

  private static dbQueryDuration = new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['collection', 'operation'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1],
  });

  private static activeUsers = new client.Gauge({
    name: 'active_users_total',
    help: 'Total number of active users',
  });

  private static errorsCount = new client.Counter({
    name: 'application_errors_total',
    help: 'Total number of application errors',
    labelNames: ['type'],
  });

  // Business Metrics
  private static transactionTotal = new client.Counter({
    name: 'business_transactions_total',
    help: 'Total number of financial transactions',
    labelNames: ['type', 'status', 'currency'],
  });

  private static transactionAmount = new client.Counter({
    name: 'business_transactions_amount_total',
    help: 'Total amount of financial transactions',
    labelNames: ['type', 'status', 'currency'],
  });

  private static userSignups = new client.Counter({
    name: 'business_users_total',
    help: 'Total number of users',
    labelNames: ['method', 'country'],
  });

  private static tontineActions = new client.Counter({
    name: 'business_tontine_actions_total',
    help: 'Total number of tontine actions',
    labelNames: ['action', 'status'],
  });

  private static budgetCreated = new client.Counter({
    name: 'business_budgets_created_total',
    help: 'Total number of budgets created',
  });

  private static subscriptionEvents = new client.Counter({
    name: 'business_subscriptions_events_total',
    help: 'Total number of subscription events',
    labelNames: ['plan', 'event', 'status'],
  });

  // --- Extended "Humanly Possible" Metrics ---

  // Auth Metrics
  private static authEvents = new client.Counter({
    name: 'auth_events_total',
    help: 'Total number of authentication events',
    labelNames: ['action', 'method', 'status', 'country', 'platform'],
  });

  private static activeSessions = new client.Gauge({
    name: 'auth_active_sessions_total',
    help: 'Number of currently active user sessions',
    labelNames: ['platform'],
  });

  // Goal Metrics
  private static goalEvents = new client.Counter({
    name: 'business_goals_total',
    help: 'Total number of saving goal events',
    labelNames: ['action', 'category', 'status'],
  });

  private static goalAmount = new client.Counter({
    name: 'business_goals_amount_total',
    help: 'Total amount added or removed from goals',
    labelNames: ['action', 'currency'],
  });

  // Challenge Metrics
  private static challengeEvents = new client.Counter({
    name: 'business_challenges_total',
    help: 'Total number of challenge participation events',
    labelNames: ['action', 'type', 'decision'],
  });

  // AI Metrics
  private static aiRequests = new client.Counter({
    name: 'ai_requests_total',
    help: 'Total number of AI service requests',
    labelNames: ['service', 'model', 'status'],
  });

  private static aiRequestDuration = new client.Histogram({
    name: 'ai_request_duration_seconds',
    help: 'Duration of AI service requests',
    labelNames: ['service', 'model'],
    buckets: [0.5, 1, 2, 5, 10, 20, 30],
  });

  private static aiCostTokens = new client.Counter({
    name: 'ai_tokens_total',
    help: 'Estimated token usage for AI services',
    labelNames: ['service', 'type'], // type: input, output
  });

  // External API Metrics
  private static externalApiRequests = new client.Counter({
    name: 'external_api_requests_total',
    help: 'Total number of external API calls',
    labelNames: ['service', 'endpoint', 'status'],
  });

  private static externalApiDuration = new client.Histogram({
    name: 'external_api_duration_seconds',
    help: 'Duration of external API calls',
    labelNames: ['service', 'endpoint'],
    buckets: [0.1, 0.5, 1, 2, 5],
  });

  // Cron Job Metrics
  private static cronJobEvents = new client.Counter({
    name: 'system_cron_jobs_total',
    help: 'Total number of cron job executions',
    labelNames: ['job', 'status'],
  });

  private static cronJobDuration = new client.Histogram({
    name: 'system_cron_job_duration_seconds',
    help: 'Duration of cron job executions',
    labelNames: ['job'],
    buckets: [1, 5, 10, 30, 60, 120, 300],
  });

  // --- Bonus Level: Deep Telemetry ---

  // Payment Gateway Metrics
  private static paymentGatewayRequests = new client.Counter({
    name: 'payment_gateway_requests_total',
    help: 'Total number of payment gateway interactions',
    labelNames: ['gateway', 'operation', 'status'], // gateway: stripe, notchpay
  });

  private static paymentGatewayDuration = new client.Histogram({
    name: 'payment_gateway_duration_seconds',
    help: 'Duration of payment gateway interactions',
    labelNames: ['gateway', 'operation'],
    buckets: [0.5, 1, 3, 5, 10, 30],
  });

  // Notification Metrics
  private static notificationPushEvents = new client.Counter({
    name: 'notifications_push_total',
    help: 'Total number of push notification attempts',
    labelNames: ['status', 'reason'], // status: success, failure, skipped
  });

  // Cache Metrics
  private static cacheOperations = new client.Counter({
    name: 'cache_operations_total',
    help: 'Total number of cache operations',
    labelNames: ['operation', 'result'], // operation: get, set; result: hit, miss, success, failure
  });

  // --- Final Polish: Quality & Health Metrics ---

  private static aiContextEfficiency = new client.Histogram({
    name: 'ai_context_efficiency_ratio',
    help: 'Ratio of context size to user query length (Higher = More Context per Query char)',
    buckets: [10, 50, 100, 500, 1000],
  });

  private static tontineDefaultRate = new client.Gauge({
    name: 'business_tontine_default_rate',
    help: 'Percentage of late tontine payments (Risk Indicator)',
  });

  private static tontineTrustScore = new client.Gauge({
    name: 'business_tontine_trust_score_avg',
    help: 'Average Trust Score of all active users',
  });

  private static sessionDuration = new client.Histogram({
    name: 'user_session_duration_seconds',
    help: 'Duration of user sessions (Login to Logout)',
    buckets: [60, 300, 600, 1800, 3600, 7200], // 1m, 5m, 10m, 30m, 1h, 2h
  });

  // --- God Mode: Executive Telemetry ---

  // Security Watchdog
  private static securityAuthFailures = new client.Counter({
    name: 'security_auth_failures_total',
    help: 'Total number of failed authentication attempts',
    labelNames: ['reason', 'country'],
  });

  private static securitySensitiveActions = new client.Counter({
    name: 'security_sensitive_actions_total',
    help: 'Total number of sensitive account actions',
    labelNames: ['action', 'status'], // action: password_change, account_delete
  });

  // Financial Pulse (Economy)
  private static economyWalletBalance = new client.Gauge({
    name: 'economy_total_wallet_balance',
    help: 'Total value of all user wallets (AUM)',
    labelNames: ['currency'],
  });

  private static economySavingsVolume = new client.Gauge({
    name: 'economy_total_savings_volume',
    help: 'Total value locked in savings goals',
    labelNames: ['currency'],
  });

  // --- Nirvana Level: Growth & Adoption ---

  private static gamificationXP = new client.Counter({
    name: 'gamification_xp_total',
    help: 'Total XP distributed to users',
    labelNames: ['action'],
  });

  private static gamificationLevels = new client.Counter({
    name: 'gamification_levels_total',
    help: 'Total levels gained by users',
  });

  private static investmentYield = new client.Gauge({
    name: 'investment_yield_ratio',
    help: 'Average yield ratio of active investments',
    labelNames: ['type'],
  });

  private static savingsImpact = new client.Counter({
    name: 'savings_impact_amount_total',
    help: 'Total volume of money saved via automated strategies',
    labelNames: ['strategy', 'currency'],
  });

  private static subscriptionChurn = new client.Counter({
    name: 'subscription_churn_total',
    help: 'Total number of subscription cancellations',
    labelNames: ['plan', 'reason'],
  });

  private static challengeFraud = new client.Counter({
    name: 'challenge_fraud_attempts_total',
    help: 'Total number of detected fraud attempts in challenges',
    labelNames: ['type'],
  });

  /**
   * Initialize custom metrics
   */
  static init() {
    client.collectDefaultMetrics({ register: this.registry });
    this.registry.registerMetric(this.httpRequestDuration);
    this.registry.registerMetric(this.dbQueryDuration);
    this.registry.registerMetric(this.activeUsers);
    this.registry.registerMetric(this.errorsCount);
    // Register Business Metrics
    this.registry.registerMetric(this.transactionTotal);
    this.registry.registerMetric(this.transactionAmount);
    this.registry.registerMetric(this.userSignups);
    this.registry.registerMetric(this.tontineActions);
    this.registry.registerMetric(this.budgetCreated);
    this.registry.registerMetric(this.subscriptionEvents);

    // Register Extended Metrics
    this.registry.registerMetric(this.authEvents);
    this.registry.registerMetric(this.activeSessions);
    this.registry.registerMetric(this.goalEvents);
    this.registry.registerMetric(this.goalAmount);
    this.registry.registerMetric(this.challengeEvents);
    this.registry.registerMetric(this.aiRequests);
    this.registry.registerMetric(this.aiRequestDuration);
    this.registry.registerMetric(this.aiCostTokens);
    this.registry.registerMetric(this.externalApiRequests);
    this.registry.registerMetric(this.externalApiDuration);
    this.registry.registerMetric(this.cronJobEvents);
    this.registry.registerMetric(this.cronJobDuration);

    // Register Bonus Metrics
    this.registry.registerMetric(this.paymentGatewayRequests);
    this.registry.registerMetric(this.paymentGatewayDuration);
    this.registry.registerMetric(this.notificationPushEvents);
    this.registry.registerMetric(this.cacheOperations);

    // Register God Mode Metrics
    this.registry.registerMetric(this.securityAuthFailures);
    this.registry.registerMetric(this.securitySensitiveActions);
    this.registry.registerMetric(this.economyWalletBalance);
    this.registry.registerMetric(this.economySavingsVolume);

    // Register Final Polish Metrics
    this.registry.registerMetric(this.aiContextEfficiency);
    this.registry.registerMetric(this.tontineDefaultRate);
    this.registry.registerMetric(this.tontineTrustScore);
    this.registry.registerMetric(this.sessionDuration);

    // Register Nirvana Level Metrics
    this.registry.registerMetric(this.gamificationXP);
    this.registry.registerMetric(this.gamificationLevels);
    this.registry.registerMetric(this.investmentYield);
    this.registry.registerMetric(this.savingsImpact);
    this.registry.registerMetric(this.subscriptionChurn);
    this.registry.registerMetric(this.challengeFraud);

    logger.info('Monitoring service initialized (Prometheus)');
  }

  // ... (metricsMiddleware remains unchanged) ...

  // Helper Methods for Business Metrics

  // ... (metricsMiddleware remains unchanged) ...

  // Helper Methods for Business Metrics

  static recordTransaction(type: string, status: string, currency: string, amount: number) {
    this.transactionTotal.labels(type, status, currency).inc();
    this.transactionAmount.labels(type, status, currency).inc(amount);
  }

  static recordUserSignup(method: string, country: string) {
    this.userSignups.labels(method, country).inc();
  }

  static recordTontineAction(action: string, status: string = 'success') {
    this.tontineActions.labels(action, status).inc();
  }

  static recordBudgetCreation() {
    this.budgetCreated.inc();
  }

  static recordSubscriptionEvent(plan: string, event: string, status: string = 'success') {
    this.subscriptionEvents.labels(plan, event, status).inc();
  }

  // --- Extended Helper Methods ---

  static recordAuthEvent(
    action: string,
    method: string,
    status: string,
    country: string = 'unknown',
    platform: string = 'unknown',
  ) {
    this.authEvents.labels(action, method, status, country, platform).inc();
  }

  static updateActiveSessions(platform: string, delta: number) {
    this.activeSessions.labels(platform).inc(delta);
  }

  static recordGoalEvent(action: string, category: string, status: string = 'success') {
    this.goalEvents.labels(action, category, status).inc();
  }

  static recordGoalAmount(action: string, currency: string, amount: number) {
    this.goalAmount.labels(action, currency).inc(amount);
  }

  static recordChallengeEvent(action: string, type: string, decision: string = 'none') {
    this.challengeEvents.labels(action, type, decision).inc();
  }

  static recordAiRequest(service: string, model: string, status: string) {
    this.aiRequests.labels(service, model, status).inc();
  }

  static observeAiDuration(service: string, model: string, durationSeconds: number) {
    this.aiRequestDuration.labels(service, model).observe(durationSeconds);
  }

  static recordAiTokens(service: string, type: 'input' | 'output', count: number) {
    this.aiCostTokens.labels(service, type).inc(count);
  }

  static recordExternalApiRequest(service: string, endpoint: string, status: string) {
    this.externalApiRequests.labels(service, endpoint, status).inc();
  }

  static observeExternalApiDuration(service: string, endpoint: string, durationSeconds: number) {
    this.externalApiDuration.labels(service, endpoint).observe(durationSeconds);
  }

  static recordCronJob(job: string, status: string) {
    this.cronJobEvents.labels(job, status).inc();
  }

  static observeCronJobDuration(job: string, durationSeconds: number) {
    this.cronJobDuration.labels(job).observe(durationSeconds);
  }

  /**
   * Middleware to track HTTP requests
   */
  static metricsMiddleware(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();

    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route ? req.route.path : req.path;

      this.httpRequestDuration
        .labels(req.method, route, res.statusCode.toString())
        .observe(duration);

      if (res.statusCode >= 400) {
        this.errorsCount.labels('http_error').inc();
      }
    });

    next();
  }

  /**
   * Expose metrics for Prometheus scraping
   */
  static async getMetrics(req: Request, res: Response) {
    res.set('Content-Type', this.registry.contentType);
    res.end(await this.registry.metrics());
  }

  /**
   * Track DB query duration
   */
  static recordDbQuery(collection: string, operation: string, durationSeconds: number) {
    this.dbQueryDuration.labels(collection, operation).observe(durationSeconds);
  }

  /**
   * Update active users gauge
   */
  static updateActiveUsers(count: number) {
    this.activeUsers.set(count);
  }

  /**
   * Increment generic error counter
   */
  static recordError(type: string) {
    this.errorsCount.labels(type).inc();
  }

  // --- Bonus Methods ---

  static recordPaymentGateway(gateway: string, operation: string, status: string) {
    this.paymentGatewayRequests.labels(gateway, operation, status).inc();
  }

  static observePaymentGatewayDuration(
    gateway: string,
    operation: string,
    durationSeconds: number,
  ) {
    this.paymentGatewayDuration.labels(gateway, operation).observe(durationSeconds);
  }

  static recordNotificationEvent(status: string, reason: string = 'none') {
    this.notificationPushEvents.labels(status, reason).inc();
  }

  static recordCacheOperation(operation: string, result: string) {
    this.cacheOperations.labels(operation, result).inc();
  }

  // --- God Mode Methods ---

  static recordAuthFailure(reason: string, country: string = 'unknown') {
    this.securityAuthFailures.labels(reason, country).inc();
  }

  static recordSensitiveAction(action: string, status: string) {
    this.securitySensitiveActions.labels(action, status).inc();
  }

  static updateEconomyMetrics(
    walletBalance: number,
    savingsVolume: number,
    currency: string = 'XAF',
  ) {
    this.economyWalletBalance.labels(currency).set(walletBalance);
    this.economySavingsVolume.labels(currency).set(savingsVolume);
  }

  // --- Final Polish Methods ---

  static recordAiContextEfficiency(contextLength: number, queryLength: number) {
    if (queryLength === 0) return;
    const ratio = contextLength / queryLength;
    this.aiContextEfficiency.observe(ratio);
  }

  static updateTontineHealth(defaultRate: number, avgTrustScore: number) {
    this.tontineDefaultRate.set(defaultRate);
    this.tontineTrustScore.set(avgTrustScore);
  }

  static recordSessionDuration(durationSeconds: number) {
    this.sessionDuration.observe(durationSeconds);
  }

  // --- Nirvana Level Methods ---

  static recordXP(amount: number, action: string = 'unknown') {
    this.gamificationXP.labels(action).inc(amount);
  }

  static recordLevelUp() {
    this.gamificationLevels.inc();
  }

  static updateInvestmentYield(yieldRatio: number, type: string = 'global') {
    this.investmentYield.labels(type).set(yieldRatio);
  }

  static recordSavingsImpact(amount: number, strategy: string, currency: string = 'XAF') {
    this.savingsImpact.labels(strategy, currency).inc(amount);
  }

  static recordChurn(plan: string, reason: string = 'manual_cancel') {
    this.subscriptionChurn.labels(plan, reason).inc();
  }

  static recordChallengeFraud(type: string) {
    this.challengeFraud.labels(type).inc();
  }
}
