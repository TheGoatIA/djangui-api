import mongoose from 'mongoose';
import logger from '../utils/logger';

const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';

    // Log masked URI for debugging (mask password)
    const maskedURI = mongoURI.replace(/:([^:@]+)@/, ':****@');
    logger.info(`Attempting to connect to MongoDB: ${maskedURI}`);

    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 10000,
    });
    logger.info('MongoDB connected successfully');
  } catch (error: any) {
    logger.error('Error connecting to MongoDB:', {
      message: error.message,
      code: error.code,
      name: error.name,
      stack: error.stack,
    });
    process.exit(1);
  }
};

export default connectDB;
