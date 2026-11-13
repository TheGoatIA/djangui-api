/* eslint-disable no-console */
/**
 * Starts the REAL Kauri API for end-to-end tests (mobile emulator, manual runs)
 * on a freshly seeded `kauri_e2e` database of the test infrastructure
 * (`npm run test:infra:up`). Same environment as the admin Playwright config.
 *
 * Every outbound side effect is DISABLED (Mailgun, Slack, Gemini, Firebase, Graylog):
 * whatever is in the developer `.env`, an E2E run can never email/notify a real person.
 *
 *   node scripts/e2e-server.js            # seed + start on :5055
 *   E2E_PUBLIC_HOST=10.0.2.2 node scripts/e2e-server.js   # signed file URLs reachable from the Android emulator
 *   E2E_SKIP_SEED=1 node scripts/e2e-server.js            # keep current data
 */
const { spawnSync, spawn } = require('child_process');
const path = require('path');

const PORT = process.env.E2E_API_PORT || '5055';
const PUBLIC_HOST = process.env.E2E_PUBLIC_HOST || '127.0.0.1';

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT,
  MONGODB_URI: 'mongodb://127.0.0.1:27037/kauri_e2e?directConnection=true',
  REDIS_URL: 'redis://127.0.0.1:6397/14',
  REDIS_PASSWORD: '',
  MINIO_ENDPOINT: 'http://127.0.0.1:9037',
  MINIO_PUBLIC_URL: `http://${PUBLIC_HOST}:9037`,
  MINIO_ACCESS_KEY: 'kauri-test',
  MINIO_SECRET_KEY: 'kauri-test-secret',
  // Throwaway values, valid only for this local test database.
  JWT_ACCESS_SECRET: '61e92c38f510742b58ad0983896503f7335838e4eca8ff4a',
  JWT_REFRESH_SECRET: 'bb008c0ca09d70f184ad84a9351a1b06ac294fa62e4a954a',
  VAULT_ENCRYPTION_KEY: 'e2e_vault_key_0123456789abcdef0123456789abcdef',
  ADMIN_URL: 'http://localhost:5173',
  SERVER_URL: `http://${PUBLIC_HOST}:${PORT}`,
  JWT_ACCESS_EXPIRATION: '2h',
  NOTCHPAY_WEBHOOK_SECRET: 'e2e_notchpay_webhook_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e',
  // Outbound side effects: OFF
  MAILGUN_API_KEY: '',
  SLACK_WEBHOOK_URL: '',
  GEMINI_API_KEY: '',
  FIREBASE_PRIVATE_KEY: '',
  FIREBASE_CLIENT_EMAIL: '',
  FIREBASE_PROJECT_ID: '',
  FIREBASE_STORAGE_BUCKET: '',
  GRAYLOG_HOST: 'disabled',
  ENABLE_TRACING: 'false',
};

const root = path.resolve(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!process.env.E2E_SKIP_SEED) {
  const seed = spawnSync(npx, ['ts-node', '--transpile-only', 'scripts/seed-e2e.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (seed.status !== 0) process.exit(seed.status || 1);
}

const server = spawn(npx, ['ts-node', '--transpile-only', 'src/server.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
