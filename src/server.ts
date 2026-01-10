import dotenv from 'dotenv';
dotenv.config();

import connectDB from './config/database';
import redis from './config/redis';
import { ChallengeService } from './services/challengeService';
import { CronService } from './services/cronService';
import { MonitoringService } from './services/monitoringService';
import logger from './utils/logger';
import { seedCountries } from './utils/seedCountries';
import app from './app'; // Keep this import as 'app' is used later
import './config/redis'; // Initialize Redis connection

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    await connectDB();

    // Seed initial data
    await seedCountries();
    await ChallengeService.seedChallenges();

    // Initialize Monitoring (Prometheus)
    MonitoringService.init();

    // Initialize Cron Jobs
    CronService.init();

    app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
