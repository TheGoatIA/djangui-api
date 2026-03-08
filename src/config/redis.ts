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
  redis = new Redis(redisURL);
}

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err: Error) => {
  logger.error(`Redis connection error: ${err.message}`);
});

export default redis;
