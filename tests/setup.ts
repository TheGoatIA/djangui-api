/**
 * Global Jest Setup File
 *
 * Provides mock environment variables for testing in environments where
 * the .env file might be missing (like CI/CD).
 */

// JWT Secrets (Min 32 chars)
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test_access_secret_32_characters_long_minimum';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test_refresh_secret_32_characters_long_minimum';

// Database
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri_test';

// Other dummy values to prevent warnings/errors
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
process.env.NOTCHPAY_PRIVATE_KEY = process.env.NOTCHPAY_PRIVATE_KEY || 'sb.test_placeholder';
process.env.METRICS_TOKEN = process.env.METRICS_TOKEN || 'test_metrics_token';
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'test-project';
process.env.PORT = process.env.PORT || '15000';
process.env.NODE_ENV = 'test';
