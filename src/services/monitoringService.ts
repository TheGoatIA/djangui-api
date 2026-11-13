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

  // ─── Extended Production Metrics (Phase 2 — Exhaustive) ───────────────────

  // 2.1 System / HTTP
  private static httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests received',
    labelNames: ['method', 'route', 'status_code'],
  });

  private static httpRequestSizeBytes = new client.Histogram({
    name: 'http_request_size_bytes',
    help: 'Size of incoming HTTP request bodies in bytes',
    labelNames: ['method', 'route'],
    buckets: [128, 512, 1024, 4096, 16384, 65536, 262144, 1048576],
  });

  private static httpResponseSizeBytes = new client.Histogram({
    name: 'http_response_size_bytes',
    help: 'Size of HTTP responses sent in bytes',
    labelNames: ['method', 'route'],
    buckets: [128, 512, 1024, 4096, 16384, 65536, 262144, 1048576],
  });

  private static activeConnections = new client.Gauge({
    name: 'active_connections',
    help: 'Number of active HTTP connections at this instant',
  });

  // 2.2 Database
  private static dbQueryTotal = new client.Counter({
    name: 'db_query_total',
    help: 'Total database queries (SELECT/INSERT/UPDATE/DELETE)',
    labelNames: ['operation', 'collection', 'status'],
  });

  private static dbConnectionPoolSize = new client.Gauge({
    name: 'db_connection_pool_size',
    help: 'Total size of the database connection pool',
  });

  private static dbConnectionPoolActive = new client.Gauge({
    name: 'db_connection_pool_active',
    help: 'Active connections in the pool',
  });

  private static dbConnectionPoolIdle = new client.Gauge({
    name: 'db_connection_pool_idle',
    help: 'Idle connections in the pool',
  });

  private static dbConnectionPoolWaiting = new client.Gauge({
    name: 'db_connection_pool_waiting',
    help: 'Requests waiting for a connection from the pool',
  });

  private static dbErrorsTotal = new client.Counter({
    name: 'db_errors_total',
    help: 'Total database errors',
    labelNames: ['error_type', 'operation'],
  });

  private static dbSlowQueriesTotal = new client.Counter({
    name: 'db_slow_queries_total',
    help: 'Database queries exceeding the slow threshold (>500ms)',
    labelNames: ['operation', 'collection'],
  });

  // 2.3 Financial Transactions (CRITIQUE)
  private static transactionsTotal = new client.Counter({
    name: 'transactions_total',
    help: 'Total financial transactions',
    labelNames: ['type', 'status', 'currency', 'payment_provider'],
  });

  private static transactionsAmountTotal = new client.Counter({
    name: 'transactions_amount_total',
    help: 'Total financial volume processed (in smallest currency unit)',
    labelNames: ['type', 'currency', 'payment_provider'],
  });

  private static transactionProcessingDuration = new client.Histogram({
    name: 'transaction_processing_duration_seconds',
    help: 'End-to-end transaction processing duration',
    labelNames: ['type', 'payment_provider'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  });

  private static transactionSuccessRate = new client.Gauge({
    name: 'transaction_success_rate',
    help: 'Transaction success rate (calculated periodically)',
    labelNames: ['payment_provider', 'transaction_type'],
  });

  private static transactionFailureTotal = new client.Counter({
    name: 'transaction_failure_total',
    help: 'Failed transactions by reason',
    labelNames: ['reason', 'payment_provider', 'transaction_type'],
  });

  private static transactionRetryTotal = new client.Counter({
    name: 'transaction_retry_total',
    help: 'Number of transaction retry attempts',
    labelNames: ['attempt_number', 'payment_provider'],
  });

  private static pendingTransactionsGauge = new client.Gauge({
    name: 'pending_transactions_gauge',
    help: 'Number of transactions in pending state',
    labelNames: ['payment_provider'],
  });

  private static transactionAmountHistogram = new client.Histogram({
    name: 'transaction_amount_histogram',
    help: 'Distribution of transaction amounts (in smallest currency unit)',
    labelNames: ['type', 'currency'],
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
  });

  private static dailyTransactionVolume = new client.Gauge({
    name: 'daily_transaction_volume',
    help: 'Financial volume processed in the last 24h',
    labelNames: ['currency'],
  });

  private static fraudAlertsTotal = new client.Counter({
    name: 'fraud_alerts_total',
    help: 'Fraud alerts triggered',
    labelNames: ['rule_triggered', 'severity'],
  });

  private static idempotencyKeyCollisionsTotal = new client.Counter({
    name: 'idempotency_key_collisions_total',
    help: 'Double-submission attempts detected by idempotency key',
    labelNames: ['endpoint'],
  });

  // 2.4 Wallets
  private static walletBalanceGauge = new client.Gauge({
    name: 'wallet_balance_gauge',
    help: 'Aggregated balance of all active wallets',
    labelNames: ['currency', 'wallet_type'],
  });

  private static walletOperationsTotal = new client.Counter({
    name: 'wallet_operations_total',
    help: 'Wallet operations (credit, debit, freeze, unfreeze)',
    labelNames: ['operation', 'currency', 'status'],
  });

  private static walletCreationTotal = new client.Counter({
    name: 'wallet_creation_total',
    help: 'New wallets created',
    labelNames: ['currency', 'wallet_type'],
  });

  private static walletFreezeTotal = new client.Counter({
    name: 'wallet_freeze_total',
    help: 'Wallets frozen',
    labelNames: ['reason'],
  });

  private static negativeBalanceAttemptsTotal = new client.Counter({
    name: 'negative_balance_attempts_total',
    help: 'Debit attempts on insufficient balance',
    labelNames: ['wallet_type'],
  });

  private static walletReconciliationDiscrepanciesTotal = new client.Counter({
    name: 'wallet_reconciliation_discrepancies_total',
    help: 'Discrepancies found during balance reconciliations',
  });

  // 2.5 Users & Auth (extended)
  private static userRegistrationsTotal = new client.Counter({
    name: 'user_registrations_total',
    help: 'New user registrations',
    labelNames: ['channel', 'country'],
  });

  private static userVerificationsTotal = new client.Counter({
    name: 'user_verifications_total',
    help: 'KYC verification steps completed',
    labelNames: ['step', 'status'],
  });

  private static authAttemptsTotal = new client.Counter({
    name: 'auth_attempts_total',
    help: 'Authentication attempts',
    labelNames: ['method', 'status'],
  });

  private static authFailuresTotal = new client.Counter({
    name: 'auth_failures_total',
    help: 'Failed authentication attempts by reason',
    labelNames: ['reason', 'method'],
  });

  private static sessionsActiveGauge = new client.Gauge({
    name: 'sessions_active_gauge',
    help: 'Active JWT sessions at this instant',
  });

  private static tokenRefreshTotal = new client.Counter({
    name: 'token_refresh_total',
    help: 'JWT token refresh attempts',
    labelNames: ['status'],
  });

  private static accountLockoutsTotal = new client.Counter({
    name: 'account_lockouts_total',
    help: 'Accounts locked (brute force, suspicious activity)',
    labelNames: ['reason'],
  });

  private static passwordResetTotal = new client.Counter({
    name: 'password_reset_total',
    help: 'Password reset requests',
    labelNames: ['channel', 'status'],
  });

  private static kycVerificationDuration = new client.Histogram({
    name: 'kyc_verification_duration_seconds',
    help: 'Duration of KYC verification process',
    labelNames: ['step', 'provider'],
    buckets: [1, 5, 10, 30, 60, 300, 600, 1800],
  });

  // 2.6 Payment Providers
  private static paymentProviderRequestsTotal = new client.Counter({
    name: 'payment_provider_requests_total',
    help: 'Calls to external payment provider APIs',
    labelNames: ['provider', 'operation', 'status'],
  });

  private static paymentProviderLatencySeconds = new client.Histogram({
    name: 'payment_provider_latency_seconds',
    help: 'Latency of calls to payment providers',
    labelNames: ['provider', 'operation'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  });

  private static paymentProviderErrorsTotal = new client.Counter({
    name: 'payment_provider_errors_total',
    help: 'Errors returned by payment providers',
    labelNames: ['provider', 'error_code', 'operation'],
  });

  private static paymentProviderAvailability = new client.Gauge({
    name: 'payment_provider_availability',
    help: 'Payment provider availability (1=up, 0=down)',
    labelNames: ['provider'],
  });

  private static webhookReceivedTotal = new client.Counter({
    name: 'webhook_received_total',
    help: 'Webhooks received from providers',
    labelNames: ['provider', 'event_type', 'status'],
  });

  private static webhookProcessingDuration = new client.Histogram({
    name: 'webhook_processing_duration_seconds',
    help: 'Webhook processing duration',
    labelNames: ['provider', 'event_type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
  });

  private static webhookRetryQueueSize = new client.Gauge({
    name: 'webhook_retry_queue_size',
    help: 'Webhooks pending reprocessing',
    labelNames: ['provider'],
  });

  // 2.7 Notifications (extended)
  private static notificationsSentTotal = new client.Counter({
    name: 'notifications_sent_total',
    help: 'Notifications sent',
    labelNames: ['channel', 'type', 'status'],
  });

  private static notificationDeliveryDuration = new client.Histogram({
    name: 'notification_delivery_duration_seconds',
    help: 'Notification delivery latency',
    labelNames: ['channel', 'provider'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  });

  private static notificationFailuresTotal = new client.Counter({
    name: 'notification_failures_total',
    help: 'Undelivered notifications',
    labelNames: ['channel', 'reason'],
  });

  private static notificationQueueSize = new client.Gauge({
    name: 'notification_queue_size',
    help: 'Notifications pending in queue',
    labelNames: ['channel', 'priority'],
  });

  // 2.8 Security & Compliance
  private static suspiciousActivityTotal = new client.Counter({
    name: 'suspicious_activity_total',
    help: 'Suspicious activities detected by anti-fraud rules',
    labelNames: ['rule', 'severity', 'action_taken'],
  });

  private static rateLimitHitsTotal = new client.Counter({
    name: 'rate_limit_hits_total',
    help: 'Requests blocked by rate limiting',
    labelNames: ['endpoint', 'tier'],
  });

  private static blockedIpsGauge = new client.Gauge({
    name: 'blocked_ips_gauge',
    help: 'IPs currently blocked',
  });

  private static complianceChecksTotal = new client.Counter({
    name: 'compliance_checks_total',
    help: 'Compliance checks performed (AML, KYC, sanctions)',
    labelNames: ['check_type', 'result'],
  });

  private static auditLogEventsTotal = new client.Counter({
    name: 'audit_log_events_total',
    help: 'Events recorded in immutable audit log',
    labelNames: ['event_type', 'actor_type'],
  });

  private static dataAccessTotal = new client.Counter({
    name: 'data_access_total',
    help: 'Access to sensitive data (GDPR)',
    labelNames: ['resource', 'actor_type', 'operation'],
  });

  // 2.9 Background Jobs (extended)
  private static backgroundJobTotal = new client.Counter({
    name: 'background_job_total',
    help: 'Background tasks executed',
    labelNames: ['job_name', 'status'],
  });

  private static backgroundJobDuration = new client.Histogram({
    name: 'background_job_duration_seconds',
    help: 'Background job execution duration',
    labelNames: ['job_name'],
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  });

  private static jobQueueSize = new client.Gauge({
    name: 'job_queue_size',
    help: 'Processing queue size',
    labelNames: ['queue_name', 'priority'],
  });

  private static jobFailedTotal = new client.Counter({
    name: 'job_failed_total',
    help: 'Failed background jobs',
    labelNames: ['job_name', 'reason'],
  });

  private static scheduledJobLastSuccessTimestamp = new client.Gauge({
    name: 'scheduled_job_last_success_timestamp',
    help: 'Timestamp of last successful run of a scheduled job',
    labelNames: ['job_name'],
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

    // Register Extended Production Metrics (Phase 2)
    // 2.1 HTTP
    this.registry.registerMetric(this.httpRequestsTotal);
    this.registry.registerMetric(this.httpRequestSizeBytes);
    this.registry.registerMetric(this.httpResponseSizeBytes);
    this.registry.registerMetric(this.activeConnections);
    // 2.2 DB
    this.registry.registerMetric(this.dbQueryTotal);
    this.registry.registerMetric(this.dbConnectionPoolSize);
    this.registry.registerMetric(this.dbConnectionPoolActive);
    this.registry.registerMetric(this.dbConnectionPoolIdle);
    this.registry.registerMetric(this.dbConnectionPoolWaiting);
    this.registry.registerMetric(this.dbErrorsTotal);
    this.registry.registerMetric(this.dbSlowQueriesTotal);
    // 2.3 Transactions
    this.registry.registerMetric(this.transactionsTotal);
    this.registry.registerMetric(this.transactionsAmountTotal);
    this.registry.registerMetric(this.transactionProcessingDuration);
    this.registry.registerMetric(this.transactionSuccessRate);
    this.registry.registerMetric(this.transactionFailureTotal);
    this.registry.registerMetric(this.transactionRetryTotal);
    this.registry.registerMetric(this.pendingTransactionsGauge);
    this.registry.registerMetric(this.transactionAmountHistogram);
    this.registry.registerMetric(this.dailyTransactionVolume);
    this.registry.registerMetric(this.fraudAlertsTotal);
    this.registry.registerMetric(this.idempotencyKeyCollisionsTotal);
    // 2.4 Wallets
    this.registry.registerMetric(this.walletBalanceGauge);
    this.registry.registerMetric(this.walletOperationsTotal);
    this.registry.registerMetric(this.walletCreationTotal);
    this.registry.registerMetric(this.walletFreezeTotal);
    this.registry.registerMetric(this.negativeBalanceAttemptsTotal);
    this.registry.registerMetric(this.walletReconciliationDiscrepanciesTotal);
    // 2.5 Users & Auth
    this.registry.registerMetric(this.userRegistrationsTotal);
    this.registry.registerMetric(this.userVerificationsTotal);
    this.registry.registerMetric(this.authAttemptsTotal);
    this.registry.registerMetric(this.authFailuresTotal);
    this.registry.registerMetric(this.sessionsActiveGauge);
    this.registry.registerMetric(this.tokenRefreshTotal);
    this.registry.registerMetric(this.accountLockoutsTotal);
    this.registry.registerMetric(this.passwordResetTotal);
    this.registry.registerMetric(this.kycVerificationDuration);
    // 2.6 Payment Providers
    this.registry.registerMetric(this.paymentProviderRequestsTotal);
    this.registry.registerMetric(this.paymentProviderLatencySeconds);
    this.registry.registerMetric(this.paymentProviderErrorsTotal);
    this.registry.registerMetric(this.paymentProviderAvailability);
    this.registry.registerMetric(this.webhookReceivedTotal);
    this.registry.registerMetric(this.webhookProcessingDuration);
    this.registry.registerMetric(this.webhookRetryQueueSize);
    // 2.7 Notifications
    this.registry.registerMetric(this.notificationsSentTotal);
    this.registry.registerMetric(this.notificationDeliveryDuration);
    this.registry.registerMetric(this.notificationFailuresTotal);
    this.registry.registerMetric(this.notificationQueueSize);
    // 2.8 Security
    this.registry.registerMetric(this.suspiciousActivityTotal);
    this.registry.registerMetric(this.rateLimitHitsTotal);
    this.registry.registerMetric(this.blockedIpsGauge);
    this.registry.registerMetric(this.complianceChecksTotal);
    this.registry.registerMetric(this.auditLogEventsTotal);
    this.registry.registerMetric(this.dataAccessTotal);
    // 2.9 Background Jobs
    this.registry.registerMetric(this.backgroundJobTotal);
    this.registry.registerMetric(this.backgroundJobDuration);
    this.registry.registerMetric(this.jobQueueSize);
    this.registry.registerMetric(this.jobFailedTotal);
    this.registry.registerMetric(this.scheduledJobLastSuccessTimestamp);

    // Initialize payment provider availability (known providers)
    ['stripe', 'notchpay'].forEach((p) => this.paymentProviderAvailability.labels(p).set(1));

    logger.info('Monitoring service initialized (Prometheus)');
  }

  // ... (metricsMiddleware remains unchanged) ...

  // Helper Methods for Business Metrics

  // ... (metricsMiddleware remains unchanged) ...

  // Helper Methods for Business Metrics

  static recordTransaction(type: string, status: string, currency: string, amount: number) {
    this.transactionTotal.labels(type, status, currency).inc();
    // A Prometheus counter throws on a negative/NaN increment. This is called
    // from WalletService's error path with the REJECTED amount (e.g. -100): the
    // metric exception replaced the intended 400 "Montant invalide" with a 500.
    // Metrics must never change an API response.
    const n = Number(amount);
    if (Number.isFinite(n) && n > 0) {
      this.transactionAmount.labels(type, status, currency).inc(n);
    }
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

    // Track active connections
    this.activeConnections.inc();

    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route ? req.route.path : req.path;
      const statusCode = res.statusCode.toString();

      this.httpRequestDuration.labels(req.method, route, statusCode).observe(duration);

      // Total requests counter
      this.httpRequestsTotal.labels(req.method, route, statusCode).inc();

      // Request body size
      const reqContentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (reqContentLength > 0) {
        this.httpRequestSizeBytes.labels(req.method, route).observe(reqContentLength);
      }

      // Response body size
      const resContentLength = parseInt((res.getHeader('content-length') as string) || '0', 10);
      if (resContentLength > 0) {
        this.httpResponseSizeBytes.labels(req.method, route).observe(resContentLength);
      }

      // Decrement active connections
      this.activeConnections.dec();

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

  // ─── Extended Production Helper Methods ────────────────────────────────────

  // 2.2 Database helpers
  static recordDbQueryTotal(operation: string, collection: string, status: 'success' | 'error') {
    this.dbQueryTotal.labels(operation, collection, status).inc();
  }

  static recordDbError(errorType: string, operation: string) {
    this.dbErrorsTotal.labels(errorType, operation).inc();
  }

  static recordDbSlowQuery(operation: string, collection: string) {
    this.dbSlowQueriesTotal.labels(operation, collection).inc();
  }

  static updateDbConnectionPool(size: number, active: number, idle: number, waiting: number) {
    this.dbConnectionPoolSize.set(size);
    this.dbConnectionPoolActive.set(active);
    this.dbConnectionPoolIdle.set(idle);
    this.dbConnectionPoolWaiting.set(waiting);
  }

  // 2.3 Financial Transactions (extended)
  static recordFullTransaction(
    type: string,
    status: string,
    currency: string,
    provider: string,
    amount: number,
  ) {
    this.transactionsTotal.labels(type, status, currency, provider).inc();
    if (status === 'success') {
      this.transactionsAmountTotal.labels(type, currency, provider).inc(amount);
      this.transactionAmountHistogram.labels(type, currency).observe(amount);
    }
  }

  static startTransactionTimer(type: string, provider: string) {
    return this.transactionProcessingDuration.labels(type, provider).startTimer();
  }

  static updateTransactionSuccessRate(provider: string, txType: string, rate: number) {
    this.transactionSuccessRate.labels(provider, txType).set(rate);
  }

  static recordTransactionFailure(reason: string, provider: string, txType: string) {
    this.transactionFailureTotal.labels(reason, provider, txType).inc();
  }

  static recordTransactionRetry(attemptNumber: number, provider: string) {
    this.transactionRetryTotal.labels(String(attemptNumber), provider).inc();
  }

  static updatePendingTransactions(provider: string, count: number) {
    this.pendingTransactionsGauge.labels(provider).set(count);
  }

  static updateDailyTransactionVolume(currency: string, volume: number) {
    this.dailyTransactionVolume.labels(currency).set(volume);
  }

  static recordFraudAlert(rule: string, severity: 'low' | 'medium' | 'high' | 'critical') {
    this.fraudAlertsTotal.labels(rule, severity).inc();
  }

  static recordIdempotencyCollision(endpoint: string) {
    this.idempotencyKeyCollisionsTotal.labels(endpoint).inc();
  }

  // 2.4 Wallet helpers
  static updateWalletBalance(currency: string, walletType: string, balance: number) {
    this.walletBalanceGauge.labels(currency, walletType).set(balance);
  }

  static recordWalletOperation(
    operation: 'credit' | 'debit' | 'freeze' | 'unfreeze',
    currency: string,
    status: 'success' | 'failure',
  ) {
    this.walletOperationsTotal.labels(operation, currency, status).inc();
  }

  static recordWalletCreation(currency: string, walletType: string = 'standard') {
    this.walletCreationTotal.labels(currency, walletType).inc();
  }

  static recordWalletFreeze(reason: string) {
    this.walletFreezeTotal.labels(reason).inc();
  }

  static recordNegativeBalanceAttempt(walletType: string = 'standard') {
    this.negativeBalanceAttemptsTotal.labels(walletType).inc();
  }

  static recordReconciliationDiscrepancy() {
    this.walletReconciliationDiscrepanciesTotal.inc();
  }

  // 2.5 User & Auth helpers (extended)
  static recordUserRegistration(channel: string, country: string) {
    this.userRegistrationsTotal.labels(channel, country).inc();
  }

  static recordUserVerification(step: string, status: 'success' | 'failure' | 'pending') {
    this.userVerificationsTotal.labels(step, status).inc();
  }

  static recordAuthAttempt(method: string, status: 'success' | 'failure') {
    this.authAttemptsTotal.labels(method, status).inc();
  }

  static recordAuthFailureReason(reason: string, method: string) {
    this.authFailuresTotal.labels(reason, method).inc();
  }

  static updateSessionsActive(delta: number) {
    this.sessionsActiveGauge.inc(delta);
  }

  static recordTokenRefresh(status: 'success' | 'failure') {
    this.tokenRefreshTotal.labels(status).inc();
  }

  static recordAccountLockout(reason: string) {
    this.accountLockoutsTotal.labels(reason).inc();
  }

  static recordPasswordReset(channel: string, status: 'success' | 'failure' | 'requested') {
    this.passwordResetTotal.labels(channel, status).inc();
  }

  static observeKycDuration(step: string, provider: string, durationSeconds: number) {
    this.kycVerificationDuration.labels(step, provider).observe(durationSeconds);
  }

  // 2.6 Payment Provider helpers
  static recordPaymentProviderRequest(provider: string, operation: string, status: string) {
    this.paymentProviderRequestsTotal.labels(provider, operation, status).inc();
  }

  static observePaymentProviderLatency(
    provider: string,
    operation: string,
    durationSeconds: number,
  ) {
    this.paymentProviderLatencySeconds.labels(provider, operation).observe(durationSeconds);
  }

  static recordPaymentProviderError(provider: string, errorCode: string, operation: string) {
    this.paymentProviderErrorsTotal.labels(provider, errorCode, operation).inc();
  }

  static updatePaymentProviderAvailability(provider: string, isUp: boolean) {
    this.paymentProviderAvailability.labels(provider).set(isUp ? 1 : 0);
  }

  static recordWebhookReceived(
    provider: string,
    eventType: string,
    status: 'processed' | 'failed' | 'duplicate' | 'invalid_signature',
  ) {
    this.webhookReceivedTotal.labels(provider, eventType, status).inc();
  }

  static observeWebhookProcessingDuration(
    provider: string,
    eventType: string,
    durationSeconds: number,
  ) {
    this.webhookProcessingDuration.labels(provider, eventType).observe(durationSeconds);
  }

  static updateWebhookRetryQueueSize(provider: string, size: number) {
    this.webhookRetryQueueSize.labels(provider).set(size);
  }

  // 2.7 Notification helpers (extended)
  static recordNotificationSent(
    channel: string,
    type: string,
    status: 'success' | 'failure' | 'skipped',
  ) {
    this.notificationsSentTotal.labels(channel, type, status).inc();
  }

  static observeNotificationDelivery(channel: string, provider: string, durationSeconds: number) {
    this.notificationDeliveryDuration.labels(channel, provider).observe(durationSeconds);
  }

  static recordNotificationFailure(channel: string, reason: string) {
    this.notificationFailuresTotal.labels(channel, reason).inc();
  }

  static updateNotificationQueueSize(channel: string, priority: string, size: number) {
    this.notificationQueueSize.labels(channel, priority).set(size);
  }

  // 2.8 Security helpers (extended)
  static recordSuspiciousActivity(
    rule: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    actionTaken: string,
  ) {
    this.suspiciousActivityTotal.labels(rule, severity, actionTaken).inc();
  }

  static recordRateLimitHit(endpoint: string, tier: string = 'default') {
    this.rateLimitHitsTotal.labels(endpoint, tier).inc();
  }

  static updateBlockedIps(count: number) {
    this.blockedIpsGauge.set(count);
  }

  static recordComplianceCheck(checkType: string, result: 'pass' | 'fail' | 'pending') {
    this.complianceChecksTotal.labels(checkType, result).inc();
  }

  static recordAuditLogEvent(eventType: string, actorType: 'user' | 'admin' | 'system') {
    this.auditLogEventsTotal.labels(eventType, actorType).inc();
  }

  static recordDataAccess(resource: string, actorType: string, operation: string) {
    this.dataAccessTotal.labels(resource, actorType, operation).inc();
  }

  // 2.9 Background Job helpers (extended)
  static recordBackgroundJob(jobName: string, status: 'success' | 'failure' | 'running') {
    this.backgroundJobTotal.labels(jobName, status).inc();
  }

  static observeBackgroundJobDuration(jobName: string, durationSeconds: number) {
    this.backgroundJobDuration.labels(jobName).observe(durationSeconds);
  }

  static updateJobQueueSize(queueName: string, priority: string, size: number) {
    this.jobQueueSize.labels(queueName, priority).set(size);
  }

  static recordJobFailed(jobName: string, reason: string) {
    this.jobFailedTotal.labels(jobName, reason).inc();
  }

  static updateScheduledJobLastSuccess(jobName: string) {
    this.scheduledJobLastSuccessTimestamp.labels(jobName).set(Date.now() / 1000);
  }
}
