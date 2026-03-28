import Redis from 'ioredis';
import logger from '../utils/logger';

const redisURL = process.env.REDIS_URL || 'redis://localhost:6379';
let redis: any;

if (process.env.NODE_ENV === 'test') {
  // Use a dummy mock for Redis in test mode to prevent socket leaks
  redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    status: 'ready',
  };
} else {
  const options: any = {
    maxRetriesPerRequest: null,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
    enableOfflineQueue: true,
  };

  // Fallback: If REDIS_PASSWORD is set but not included in REDIS_URL, add it to options
  const hasUserPass = redisURL.includes('@');
  if (process.env.REDIS_PASSWORD && !hasUserPass) {
    options.password = process.env.REDIS_PASSWORD;
  }

  redis = new Redis(redisURL, options);
}

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

// Explicitly handle authentication errors to provide better feedback
redis.on('error', (err: any) => {
  if (err.message.includes('NOAUTH')) {
    logger.error('CRITICAL: Redis requires authentication but none was provided or it was incorrect.');
  } else {
    logger.error(`Redis connection error: ${err.message}`);
  }
});

export default redis;
