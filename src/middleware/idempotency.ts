import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import redis from '../config/redis';
import { AppError } from './errorHandler';
import logger from '../utils/logger';

const IDEMPOTENCY_KEY_TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to cover client retries

/**
 * Protects money-mutating routes (withdrawals, deposits, contributions,
 * redemptions, payment checkouts) against duplicate submissions — e.g. a
 * client retrying a timed-out request, or a double-tap on a submit button.
 *
 * The client sends an `Idempotency-Key` header (a client-generated UUID,
 * stable across retries of the *same* logical operation). The key is claimed
 * atomically with Redis `SET NX` — this is the part that matters: a
 * read-then-write ("GET, check, SET") would leave a race window where two
 * near-simultaneous requests both pass the check before either persists its
 * claim, defeating the whole point of the guard. `NX` makes the claim and
 * the check a single atomic operation.
 *
 * If the client doesn't send the header, the request proceeds unprotected —
 * this middleware only adds a guarantee, it never blocks a caller that
 * hasn't opted in.
 */
export async function idempotency(req: AuthRequest, res: Response, next: NextFunction) {
  const key = req.headers['idempotency-key'] as string | undefined;
  if (!key) return next();

  const userId = req.user?._id?.toString() || 'anonymous';
  const redisKey = `idempotency:${userId}:${req.originalUrl}:${key}`;

  try {
    const claimed = await redis.set(redisKey, '1', 'EX', IDEMPOTENCY_KEY_TTL_SECONDS, 'NX');
    if (claimed === null) {
      return next(new AppError('Duplicate request: this operation was already submitted', 409));
    }
    next();
  } catch (error: any) {
    // If Redis is unavailable, fail open rather than blocking all money
    // operations on an infrastructure outage — log loudly so it's noticed.
    logger.error(`Idempotency middleware Redis error: ${error.message}`);
    next();
  }
}
