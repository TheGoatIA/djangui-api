import connectDB from './config/database';
import redis from './config/redis';
import { ChallengeService } from './services/challengeService';
import logger from './utils/logger';
import app from './app'; // Keep this import as 'app' is used later
import './config/redis'; // Initialize Redis connection

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        await connectDB();

        // Seed initial challenges
        await ChallengeService.seedChallenges();

        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT} in ${process.env.NODE_ENV} mode`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();
