import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import redis from '../config/redis';
import logger from '../utils/logger';

/**
 * Per-user DAILY quota on endpoints that call a paid AI model (Gemini).
 * The coach and SMS parsing had no quota and no size cap: any free account
 * could generate unbounded AI cost. Limits are env-tunable
 * (AI_QUOTA_<FEATURE>_FREE / _PREMIUM). `weight` lets one request consume
 * several units (bulk SMS parsing = one unit per message).
 */
export function aiQuota(
  feature: string,
  defaults: { free: number; premium: number },
  weight: (req: AuthRequest) => number = () => 1,
) {
  const envKey = `AI_QUOTA_${feature.toUpperCase()}`;
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next();
    const limit = user.isPremium
      ? Number(process.env[`${envKey}_PREMIUM`]) || defaults.premium
      : Number(process.env[`${envKey}_FREE`]) || defaults.free;
    const units = Math.max(1, weight(req));
    const day = new Date().toISOString().slice(0, 10);
    const key = `aiq:${feature}:${user._id}:${day}`;
    try {
      const used = await redis.incrby(key, units);
      if (used === units) await redis.expire(key, 2 * 24 * 3600);
      if (used > limit) {
        await redis.decrby(key, units); // a refused call does not consume quota
        return res.status(429).json({
          status: 'error',
          code: 'AI_QUOTA_EXCEEDED',
          message: user.isPremium
            ? "Limite quotidienne d'utilisation de l'IA atteinte. Réessayez demain."
            : "Limite quotidienne de l'IA atteinte pour le plan gratuit. Passez Premium pour continuer.",
          limit,
        });
      }
      res.setHeader('X-AI-Quota-Remaining', String(Math.max(0, limit - used)));
      next();
    } catch (err: any) {
      // Fail open on a Redis outage (consistent with idempotency/lockout).
      logger.error(`aiQuota Redis error: ${err.message}`);
      next();
    }
  };
}

/** Rejects oversized text before it reaches (and is billed by) the model. */
export const maxTextLength =
  (field: string, max: number) => (req: AuthRequest, res: Response, next: NextFunction) => {
    const v = req.body?.[field];
    if (typeof v === 'string' && v.length > max) {
      return res.status(400).json({
        status: 'error',
        message: `Texte trop long (${max} caractères maximum).`,
      });
    }
    next();
  };
