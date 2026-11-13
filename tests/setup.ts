/**
 * Global Jest setup — exécuté AVANT chaque fichier de test (et donc avant que
 * l'app ne charge `.env` via dotenv, qui n'écrase jamais une variable déjà définie).
 *
 * Règles :
 *  - L'infrastructure (Mongo, MinIO, Redis) est TOUJOURS celle de test : jamais la
 *    base de dev, jamais le MinIO partagé du VPS.
 *  - Les services à effet de bord externe (emails Mailgun, Slack, push Firebase,
 *    Gemini payant) sont neutralisés : un test ne doit jamais écrire à un vrai humain.
 *  - Seules les clés de PAIEMENT SANDBOX sont reprises de `.env` (tests "réels" contre
 *    Stripe test-mode / NotchPay sandbox). Une clé live est refusée net.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const envFile = path.resolve(__dirname, '..', '.env');
const fileEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

const SANDBOX_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'NOTCHPAY_PUBLIC_KEY',
  'NOTCHPAY_PRIVATE_KEY',
];
for (const k of SANDBOX_KEYS) {
  const v = process.env[k] || fileEnv[k];
  if (!v) continue;
  if (/^(sk|pk|rk)_live|^(sk|pk)\.live/i.test(v)) {
    throw new Error(
      `[tests] ${k} est une clé LIVE : refus de lancer les tests avec de l'argent réel.`,
    );
  }
  process.env[k] = v;
}
// Vrai si une clé sandbox réelle est disponible (sinon les suites "provider réel" sont ignorées)
process.env.HAS_STRIPE_SANDBOX = /^sk_test_[A-Za-z0-9]{20,}/.test(
  process.env.STRIPE_SECRET_KEY || '',
)
  ? '1'
  : '';
process.env.HAS_NOTCHPAY_SANDBOX = /^sk_test\.[A-Za-z0-9]{10,}/.test(
  process.env.NOTCHPAY_PRIVATE_KEY || '',
)
  ? '1'
  : '';

process.env.NODE_ENV = 'test';

// JWT (≥ 32 caractères)
process.env.JWT_ACCESS_SECRET = 'test_access_secret_32_characters_long_minimum';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_32_characters_long_minimum';

// --- Infrastructure de test (docker-compose.test.yml en local, services CI sinon) ---
process.env.MONGO_RS_URI =
  process.env.MONGO_RS_URI || 'mongodb://127.0.0.1:27037/?directConnection=true';
process.env.MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27037/kauri_test?directConnection=true';
process.env.MINIO_ENDPOINT = process.env.TEST_MINIO_ENDPOINT || 'http://127.0.0.1:9037';
process.env.MINIO_PUBLIC_URL = process.env.MINIO_ENDPOINT;
process.env.MINIO_ACCESS_KEY = 'kauri-test';
process.env.MINIO_SECRET_KEY = 'kauri-test-secret';
// Redis RÉEL de test, une base logique par worker Jest (isolation des runs parallèles)
process.env.REDIS_URL = `${process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6397'}/${process.env.JEST_WORKER_ID || '0'}`;
process.env.REDIS_PASSWORD = '';

// --- Effets de bord externes neutralisés ---
process.env.MAILGUN_API_KEY = '';
process.env.SLACK_WEBHOOK_URL = '';
process.env.FIREBASE_PRIVATE_KEY = '';
process.env.FIREBASE_CLIENT_EMAIL = '';
process.env.GEMINI_API_KEY = '';
process.env.GRAYLOG_HOST = 'disabled';
process.env.ENABLE_TRACING = 'false';

// Valeurs factices déterministes
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_kauri_webhook_secret';
process.env.NOTCHPAY_PRIVATE_KEY = process.env.NOTCHPAY_PRIVATE_KEY || 'sb.test_placeholder';
process.env.NOTCHPAY_WEBHOOK_SECRET = 'notchpay_test_webhook_secret';
process.env.METRICS_TOKEN = 'test_metrics_token';
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.VAULT_ENCRYPTION_KEY =
  process.env.VAULT_ENCRYPTION_KEY && process.env.VAULT_ENCRYPTION_KEY.length >= 32
    ? process.env.VAULT_ENCRYPTION_KEY
    : 'a'.repeat(64);
process.env.SWAGGER_USER = 'swagger';
process.env.SWAGGER_PASSWORD = 'swagger-test-password';
process.env.PORT = '15000';
