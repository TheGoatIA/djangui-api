import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app';
import User from '../../src/models/User';
import redis from '../../src/config/redis';

describe('Authentication Integration Tests', () => {
  const testUser = {
    email: 'test@example.com',
    password: 'Password123!',
    firstName: 'Test',
    lastName: 'User',
  };

  beforeAll(async () => {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri_test';
    await mongoose.connect(mongoURI);
  });

  afterAll(async () => {
    await User.deleteMany({});
    await mongoose.connection.close(true);

    // Also close Redis connection opened by app/rateLimiter
    if (redis.status === 'ready' || redis.status === 'connect') {
      redis.disconnect();
    }
  });

  beforeEach(async () => {
    await User.deleteMany({});
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user successfully', async () => {
      const res = await request(app).post('/api/v1/auth/register').send(testUser);

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(testUser.email);
      expect(res.body.data.tokens).toHaveProperty('accessToken');
      expect(res.body.data.tokens).toHaveProperty('refreshToken');
      expect(res.body.data.user).not.toHaveProperty('password');
    });

    it('should fail if email already exists', async () => {
      await request(app).post('/api/v1/auth/register').send(testUser);
      const res = await request(app).post('/api/v1/auth/register').send(testUser);

      expect(res.statusCode).toBe(409);
      expect(res.body.status).toBe('error');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login successfully with correct credentials', async () => {
      await request(app).post('/api/v1/auth/register').send(testUser);

      const res = await request(app).post('/api/v1/auth/login').send({
        email: testUser.email,
        password: testUser.password,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tokens).toHaveProperty('accessToken');
    });

    it('should fail with incorrect password', async () => {
      await request(app).post('/api/v1/auth/register').send(testUser);

      const res = await request(app).post('/api/v1/auth/login').send({
        email: testUser.email,
        password: 'wrongpassword',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
