import redis from '../../src/config/redis';

describe('Redis Integration', () => {
    afterAll(async () => {
        // Gracefully close the redis connection after tests
        await redis.quit();
    });

    it('should connect to Redis', async () => {
        const status = redis.status;
        expect(['connect', 'ready', 'reconnecting']).toContain(status);
    });

    it('should set and get a value in Redis', async () => {
        const key = 'test-key';
        const value = 'test-value';

        await redis.set(key, value);
        const result = await redis.get(key);

        expect(result).toBe(value);
    });

    it('should delete a value from Redis', async () => {
        const key = 'test-delete-key';
        const value = 'to-be-deleted';

        await redis.set(key, value);
        await redis.del(key);
        const result = await redis.get(key);

        expect(result).toBeNull();
    });

    it('should handle set with expiration', async () => {
        const key = 'test-expire-key';
        const value = 'expires-soon';
        const ttl = 1; // 1 second

        await redis.set(key, value, 'EX', ttl);
        const resultBefore = await redis.get(key);
        expect(resultBefore).toBe(value);

        // Wait for expiration
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const resultAfter = await redis.get(key);
        expect(resultAfter).toBeNull();
    });
});
