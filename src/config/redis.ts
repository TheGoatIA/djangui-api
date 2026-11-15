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

// Tests use a REAL Redis too (docker-compose.test.yml): rate limiting, JWT
// blacklist, login lockout and idempotency are exercised exactly as in production.
if (process.env.NODE_ENV === 'production' && !finalRedisURL.startsWith('rediss://')) {
  logger.warn('⚠️ [SECURITY] Redis connection in production is not using TLS (rediss://)');
}

redis = new Redis(finalRedisURL, {
  // This client backs hot-path checks on every request (the global rate
  // limiter, the JWT blacklist check, the idempotency lock) — a bounded
  // commandTimeout + maxRetriesPerRequest ensures a stuck command always
  // surfaces as an error within a few seconds instead of queuing/retrying
  // indefinitely and hanging the whole API during a Redis outage.
  commandTimeout: 5000,
  maxRetriesPerRequest: 2,
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
  if (err.message && err.message.includes('NOAUTH')) {
    logger.error(
      'CRITICAL: Redis authentication failed. Please check REDIS_PASSWORD and REDIS_URL.',
    );
  } else {
    logger.error(`Redis connection error: ${err.message || err}`);
  }
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

export default redis;
