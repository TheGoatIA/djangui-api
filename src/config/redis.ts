import Redis from 'ioredis';
import logger from '../utils/logger';

const redisURL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisURL);

redis.on('connect', () => {
    logger.info('Connected to Redis');
});

redis.on('error', (err) => {
    logger.error(`Redis connection error: ${err.message}`);
});

export default redis;
