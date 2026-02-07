import redis from '../config/redis';
import logger from '../utils/logger';
import { MonitoringService } from './monitoringService';

export class RedisService {
  /**
   * Set a value in cache with an optional TTL
   */
  static async set(key: string, value: any, ttlSeconds: number = 3600) {
    try {
      const stringValue = JSON.stringify(value);
      await redis.set(key, stringValue, 'EX', ttlSeconds);
      MonitoringService.recordCacheOperation('set', 'success');
    } catch (err: any) {
      logger.error(`Error setting Redis key ${key}: ${err.message}`);
      MonitoringService.recordCacheOperation('set', 'failure');
    }
  }

  /**
   * Get a value from cache
   */
  static async get<T>(key: string): Promise<T | null> {
    try {
      const value = await redis.get(key);
      if (!value) {
        MonitoringService.recordCacheOperation('get', 'miss');
        return null;
      }
      MonitoringService.recordCacheOperation('get', 'hit');
      return JSON.parse(value) as T;
    } catch (err: any) {
      logger.error(`Error getting Redis key ${key}: ${err.message}`);
      MonitoringService.recordCacheOperation('get', 'failure');
      return null;
    }
  }

  /**
   * Delete a key from cache
   */
  static async del(key: string) {
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.error(`Error deleting Redis key ${key}: ${err.message}`);
    }
  }

  /**
   * Generate a cache key
   */
  static generateKey(prefix: string, ...parts: string[]): string {
    return `${prefix}:${parts.join(':')}`;
  }
}
