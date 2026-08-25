import mongoose from 'mongoose';
import logger from '../utils/logger';
import { MonitoringService } from '../services/monitoringService';

const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';

    // In production, ensure TLS is enabled (F23)
    if (process.env.NODE_ENV === 'production' && !mongoURI.includes('tls=true') && !mongoURI.includes('ssl=true') && !mongoURI.includes('mongodb+srv://')) {
      logger.warn('⚠️ [SECURITY] MongoDB connection in production is not using explicit TLS/SSL parameters (tls=true)');
    }

    // Log masked URI for debugging (mask password)
    const maskedURI = mongoURI.replace(/:([^:@]+)@/, ':****@');
    logger.info(`Attempting to connect to MongoDB: ${maskedURI}`);

    await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 10000,
    });
    logger.info('MongoDB connected successfully');

    // ── Connection pool metrics (additive, no logic change) ──────────────────
    const collectPoolStats = async () => {
      try {
        if (!mongoose.connection.db) return;
        const adminDb = mongoose.connection.db.admin();
        const status = await adminDb.serverStatus();
        const conn = status.connections;
        MonitoringService.updateDbConnectionPool(
          (conn.current || 0) + (conn.available || 0),
          conn.current || 0,
          conn.available || 0,
          conn.awaitingTopologyChanges || 0,
        );
      } catch {
        // serverStatus unavailable (auth/permissions) — emit minimal state
        const readyState = mongoose.connection.readyState;
        MonitoringService.updateDbConnectionPool(
          readyState === 1 ? 1 : 0,
          readyState === 1 ? 1 : 0,
          0,
          0,
        );
      }
    };

    collectPoolStats();
    const poolInterval = setInterval(collectPoolStats, 30_000);

    mongoose.connection.once('disconnected', () => {
      clearInterval(poolInterval);
      MonitoringService.updateDbConnectionPool(0, 0, 0, 0);
    });
    // ─────────────────────────────────────────────────────────────────────────
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
