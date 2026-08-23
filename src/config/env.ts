/**
 * Environment variable validation — called once at startup before any service
 * is initialised. If a required variable is missing the process exits immediately
 * with a clear diagnostic instead of silently falling back to an insecure default.
 */

const REQUIRED_VARS: string[] = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'MONGODB_URI',
  'REDIS_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NOTCHPAY_PUBLIC_KEY',
  'NOTCHPAY_PRIVATE_KEY',
  'NOTCHPAY_WEBHOOK_SECRET',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'GEMINI_API_KEY',
  'SWAGGER_USER',
  'SWAGGER_PASSWORD',
  'ADMIN_URL',
  'MAILGUN_API_KEY',
  'MAILGUN_DOMAIN',
];

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_VARS) {
    const value = process.env[key];
    if (!value || value.trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(
      `\n🚨 [ENV] Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join('\n')}\n\nCopy .env.example to .env and fill in the missing values.\n`,
    );
    process.exit(1);
  }

  // Additional strength checks for secrets
  const jwtAccess = process.env.JWT_ACCESS_SECRET!;
  const jwtRefresh = process.env.JWT_REFRESH_SECRET!;
  const swaggerPwd = process.env.SWAGGER_PASSWORD!;

  if (jwtAccess.length < 32) {
    console.error('🚨 [ENV] JWT_ACCESS_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32');
    process.exit(1);
  }

  if (jwtRefresh.length < 32) {
    console.error('🚨 [ENV] JWT_REFRESH_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32');
    process.exit(1);
  }

  if (swaggerPwd.length < 12) {
    console.error('🚨 [ENV] SWAGGER_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  // Warn about insecure known defaults that may have been copied from examples
  const INSECURE_DEFAULTS = ['kauri2026', 'kaurisecret', 'changeme', 'your_strong_password', 'password'];
  for (const key of ['SWAGGER_PASSWORD', 'MONGODB_PASSWORD', 'REDIS_PASSWORD', 'MINIO_SECRET_KEY']) {
    const val = process.env[key] || '';
    if (INSECURE_DEFAULTS.some((d) => val.toLowerCase().includes(d))) {
      console.warn(`⚠️  [ENV] ${key} looks like an insecure default value. Please change it before going to production.`);
    }
  }
}
