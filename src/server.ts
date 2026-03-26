import dotenv from 'dotenv';
dotenv.config();

import logger from './utils/logger';

// Global Error Handlers (CRITICAL: Capture any crash before/during startup)
process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught Exception:', error);
  if (logger) logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
  if (logger) logger.error('Unhandled Rejection:', { reason, promise });
  process.exit(1);
});

import { initTracing } from './config/tracing';
// Initialize OpenTelemetry Tracing
initTracing();

import mongoose from 'mongoose';

import connectDB from './config/database';
import redis from './config/redis';
import { ChallengeService } from './services/challengeService';
import { CronService } from './services/cronService';
import { MonitoringService } from './services/monitoringService';
import { FeatureFlagService } from './services/featureFlagService';
import { seedCountries } from './utils/seedCountries';
import { MigrationService } from './services/migrationService';
import app from './app'; // Keep this import as 'app' is used later
import './config/redis'; // Initialize Redis connection

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    logger.info('Step 1: Connecting to MongoDB...');
    await connectDB();
    logger.info('Step 1: Connected to MongoDB');

    // Seed initial data
    logger.info('Step 2: Seeding data...');
    await seedCountries();
    await ChallengeService.seedChallenges();
    await FeatureFlagService.seed();
    logger.info('Step 2: Data seeded');

    // Run migrations
    logger.info('Step 2.5: Running migrations...');
    await MigrationService.runInitialFintechMigration();
    await MigrationService.runRealMoneyMigration();
    logger.info('Step 2.5: Migrations completed');

    // Initialize Monitoring (Prometheus)
    logger.info('Step 3: Init Monitoring...');
    MonitoringService.init();

    // Initialize Cron Jobs
    // Prevent multiple executions in PM2 cluster mode by only running on instance 0
    if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
      logger.info('Step 4: Init Cron...');
      CronService.init();
    } else {
      logger.info(`Step 4: Skipped Cron init on PM2 cluster instance ${process.env.NODE_APP_INSTANCE}`);
    }

    const server = app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    });

    // --- HIGH CONCURRENCY & STABILITY OPTIMIZATIONS ---

    // 1. Fix intermittent "Connection reset by peer"
    // Must be higher than reverse proxy (Nginx) timeout (default 65s)
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    // 2. Optimization for low latency / high throughput
    server.on('connection', (socket) => {
      socket.setNoDelay(true); // Disable Nagle's algorithm for faster small packet delivery
    });

    // 3. Graceful Shutdown (Essential for stability during deployments)
    const shutdown = (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);
      server.close(() => {
        logger.info('HTTP server closed. Cleaning up resources...');
        // Close DB, Redis, etc.
        Promise.all([mongoose.connection.close(), redis.quit()])
          .then(() => {
            logger.info('Clean shutdown complete. Exiting.');
            process.exit(0);
          })
          .catch((err) => {
            logger.error('Error during shutdown:', err);
            process.exit(1);
          });
      });

      // Force shutdown after 20s if it takes too long
      setTimeout(() => {
        logger.error('Could not close connections in time, forceful shutdown.');
        process.exit(1);
      }, 20000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
