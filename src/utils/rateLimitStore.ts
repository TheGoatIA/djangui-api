import { RedisStore } from 'rate-limit-redis';
import redis from '../config/redis';
import logger from './logger';

/**
 * Builds a Redis-backed store for express-rate-limit, shared by the global
 * limiter (app.ts) and the per-route auth limiters (auth.routes.ts) so this
 * fix only has to exist in one place.
 *
 * RedisStore's constructor kicks off two Lua `SCRIPT LOAD` commands
 * (`this.incrementScriptSha = this.loadIncrementScript()`, same for
 * `getScriptSha`) without awaiting or catching the resulting promise. If
 * Redis isn't reachable/ready yet at the moment the store is constructed —
 * which happens at module load, i.e. very early in startup, often before the
 * Redis connection has finished handshaking — that promise can reject once it
 * hits our client's bounded `commandTimeout`/`maxRetriesPerRequest` (see
 * config/redis.ts), and since nothing in the library ever awaits it, that
 * becomes a genuine unhandled promise rejection that crashes the whole
 * process on Node's fail-fast default.
 *
 * This doesn't change the library's real error handling on the request path
 * (`retryableIncrement` already catches a stale/missing script and reloads it
 * there, correctly) — it only prevents this one-time startup race from being
 * able to take the entire API down over a transient Redis hiccup.
 */
export function createRateLimitStore(prefix: string): RedisStore | undefined {
  if (process.env.NODE_ENV === 'test') return undefined;

  try {
    const store = new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => (redis as any).call(...args),
    });

    (store as any).incrementScriptSha?.catch?.((err: any) =>
      logger.error(`rate-limit-redis script preload failed for prefix "${prefix}": ${err.message}`),
    );
    (store as any).getScriptSha?.catch?.((err: any) =>
      logger.error(`rate-limit-redis script preload failed for prefix "${prefix}": ${err.message}`),
    );

    return store;
  } catch (err: any) {
    logger.error(`Failed to construct RedisStore for prefix "${prefix}": ${err.message}`);
    return undefined; // express-rate-limit falls back to its in-memory store
  }
}
