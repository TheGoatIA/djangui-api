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
  // In-memory stand-in so integration tests can exercise real request flows
  // (auth blacklist checks, idempotency, rate limiting) without a live Redis.
  const store = new Map<string, string>();
  redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    status: 'ready',
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    }),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    // Counters / pipelines used by the login lockout (AuthService.login)
    incr: jest.fn(async (key: string) => {
      const n = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(n));
      return n;
    }),
    expire: jest.fn(async () => 1),
    multi: jest.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const chain: any = {
        incr: (key: string) => {
          ops.push(async () => {
            const n = Number(store.get(key) ?? 0) + 1;
            store.set(key, String(n));
            return n;
          });
          return chain;
        },
        expire: () => {
          ops.push(async () => 1);
          return chain;
        },
        exec: async () => {
          const out: unknown[] = [];
          for (const op of ops) out.push([null, await op()]);
          return out;
        },
      };
      return chain;
    }),
    info: jest.fn().mockResolvedValue(''),
    call: jest.fn().mockResolvedValue(null),
  };
} else {
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
}

export default redis;
