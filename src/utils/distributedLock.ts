import crypto from 'crypto';
import redis from '../config/redis';
import { AppError } from '../middleware/errorHandler';
import logger from './logger';

const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Serializes a critical section (e.g. "check quota, then create the row that
 * counts against it") across concurrent requests/instances via a Redis
 * SET-NX lock — the same primitive already used by idempotency.ts. A plain
 * count-then-create has a race window where two near-simultaneous requests
 * both read the same count before either persists its write, letting both
 * through even though only one should fit under the limit.
 *
 * The lock value is a random token so release only ever deletes a lock this
 * call actually holds — not one re-acquired by someone else after this call's
 * own TTL expired (e.g. a slow request).
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomBytes(16).toString('hex');
  const lockKey = `lock:${key}`;

  const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (!acquired) {
    throw new AppError('Une autre opération est déjà en cours, veuillez réessayer.', 409);
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(UNLOCK_SCRIPT, 1, lockKey, token);
    } catch (err: any) {
      // Best-effort release — the TTL guarantees the lock is freed regardless.
      logger.error(`distributedLock release error for ${lockKey}: ${err.message}`);
    }
  }
}
