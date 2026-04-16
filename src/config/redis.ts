import Redis from 'ioredis';
import logger from '../utils/logger';

// Robust Redis URL parsing and reconstruction
const getRedisConfig = () => {
  const rawUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const password = process.env.REDIS_PASSWORD;

  // If password exists but is not in the URL, reconstruct the URL
  // This is the most reliable way to ensure ioredis uses the password
  if (password && !rawUrl.includes('@')) {
    try {
      const url = new URL(rawUrl);
      url.password = password;
      return url.toString();
    } catch (e) {
      // Fallback for non-standard URLs
      if (rawUrl.startsWith('redis://')) {
        return `redis://:${password}@${rawUrl.slice(8)}`;
      }
    }
  }
  return rawUrl;
};

const finalRedisURL = getRedisConfig();
let redis: any;

if (process.env.NODE_ENV === 'test') {
  redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    status: 'ready',
  };
} else {
  // Use lazyConnect to ensure we can attach error listeners before connection attempts
  redis = new Redis(finalRedisURL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    enableOfflineQueue: true,
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) return true;
      return false;
    },
  });

  // Attach error listener immediately
  redis.on('error', (err: any) => {
    if (err.message.includes('NOAUTH')) {
      logger.error(
        'CRITICAL: Redis authentication failed. Please check REDIS_PASSWORD and REDIS_URL.',
      );
    } else {
      logger.error(`Redis connection error: ${err.message}`);
    }
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis');
  });

  // Manually trigger connection and catch initial failure to prevent unhandled rejection
  redis.connect().catch((err: any) => {
    logger.error(`Initial Redis connection failed: ${err.message}`);
  });
}

export default redis;
