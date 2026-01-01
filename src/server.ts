import app from './app';
import connectDB from './config/database';
import logger from './utils/logger';
import './config/redis'; // Initialize Redis connection

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT} in ${process.env.NODE_ENV} mode`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();
