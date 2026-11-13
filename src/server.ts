import dotenv from 'dotenv';
dotenv.config();

import logger from './utils/logger';

/**
 * Validate critical environment variables before starting the server.
 * Missing secrets cause immediate process exit to prevent insecure startup.
 */
const validateEnvironment = () => {
  const required: { key: string; minLength?: number }[] = [
    { key: 'JWT_ACCESS_SECRET', minLength: 32 },
    { key: 'JWT_REFRESH_SECRET', minLength: 32 },
    { key: 'VAULT_ENCRYPTION_KEY', minLength: 32 },
    { key: 'MONGODB_URI' },
  ];

  const weakDefaults = [
    'super-secret',
    'super-secret-refresh',
    'changeme',
    'password',
    'secret',
    'kaurisecret',
    'kauriadmin',
    'kauri2026',
    'admin',
  ];
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Variables requises (bloquantes) ──
  for (const { key, minLength } of required) {
    const value = process.env[key];
    if (!value) {
      errors.push(`Variable d'environnement manquante : ${key}`);
      continue;
    }
    if (minLength && value.length < minLength) {
      errors.push(`${key} est trop courte (min ${minLength} chars, reçu ${value.length})`);
    }
    // MONGODB_URI contient légitimement le mot "admin" en clair (authSource=admin
    // et/ou nom d'utilisateur admin, standard MongoDB) — vérifier la chaîne
    // entière produit un faux positif systématique. On isole le mot de passe
    // (entre ":" et "@") et on ne teste que lui contre les valeurs faibles.
    const checkedValue =
      key === 'MONGODB_URI' ? (value.match(/:\/\/[^:]+:([^@]+)@/)?.[1] ?? value) : value;
    if (weakDefaults.some((d) => checkedValue.toLowerCase().includes(d))) {
      errors.push(
        `${key} contient une valeur par défaut faible — utiliser un secret aléatoire fort`,
      );
    }
  }

  // ── Vérifications production uniquement (bloquantes) ──
  if (process.env.NODE_ENV === 'production') {
    // Backups: the only off-server copy is Firebase Storage (MinIO runs on the
    // same VPS as the database).
    if (!process.env.FIREBASE_STORAGE_BUCKET) {
      console.error('🚨 FIREBASE_STORAGE_BUCKET manquant : AUCUNE sauvegarde hors du serveur.');
    }
    if (!process.env.BACKUP_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY.length < 32) {
      console.error('🚨 BACKUP_ENCRYPTION_KEY absente/trop courte : sauvegardes non chiffrées.');
    }
    // Webhook secrets: not blocking (the rest of the app must keep running),
    // but payment initialisation is refused without them (PaymentService).
    for (const k of ['NOTCHPAY_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET']) {
      if (!process.env[k]) {
        console.error(`🚨 ${k} manquant : les paiements correspondants sont DÉSACTIVÉS.`);
      }
    }
    // Swagger
    const swaggerPassword = process.env.SWAGGER_PASSWORD;
    if (!swaggerPassword || swaggerPassword === 'kauri2026' || swaggerPassword.length < 12) {
      errors.push('SWAGGER_PASSWORD doit être un mot de passe fort (min 12 chars) en production');
    }

    // MinIO — noms alignés sur storageService.ts / docker-compose (MINIO_ACCESS_KEY / MINIO_SECRET_KEY)
    const minioSecretKey = process.env.MINIO_SECRET_KEY;
    if (!minioSecretKey || minioSecretKey === 'kaurisecret' || minioSecretKey.length < 12) {
      errors.push('MINIO_SECRET_KEY doit être défini et fort (min 12 chars) en production');
    }
    const minioAccessKey = process.env.MINIO_ACCESS_KEY;
    if (!minioAccessKey || minioAccessKey === 'kauriadmin') {
      errors.push(
        'MINIO_ACCESS_KEY ne doit pas utiliser la valeur par défaut "kauriadmin" en production',
      );
    }

    // IA
    if (!process.env.GEMINI_API_KEY) {
      errors.push('GEMINI_API_KEY est requis en production (coach IA, OCR, KYC)');
    }

    // Passerelles de paiement — au moins une doit être configurée
    const hasStripe = !!process.env.STRIPE_SECRET_KEY;
    const hasNotchPay = !!process.env.NOTCHPAY_PRIVATE_KEY;
    if (!hasStripe && !hasNotchPay) {
      errors.push(
        'Au moins une passerelle de paiement doit être configurée en production (STRIPE_SECRET_KEY ou NOTCHPAY_PRIVATE_KEY)',
      );
    }

    // Variables lues par les services au runtime : leur absence ne casse pas le
    // démarrage mais désactive silencieusement une fonctionnalité de sécurité
    // ou une intégration — en production on refuse de démarrer.
    for (const key of [
      'REDIS_URL',
      'ADMIN_URL',
      'SWAGGER_USER',
      'MAILGUN_API_KEY',
      'MAILGUN_DOMAIN',
      // Clé client : sans elle, /system/telemetry/* serait ouvert à tout Internet.
      'MOBILE_CLIENT_API_KEY',
    ]) {
      if (!process.env[key]) {
        errors.push(`${key} est requis en production`);
      }
    }
    // Webhooks de paiement : sans secret, ils sont tous rejetés (400/401) — aucun risque de
    // fausse validation — et les paiements sont alors confirmés par le sondage actif du
    // fournisseur (PaymentPollingService, chaque minute). On avertit sans bloquer le démarrage.
    if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
      warnings.push(
        'STRIPE_WEBHOOK_SECRET non défini — webhooks Stripe désactivés ; paiements confirmés par polling (≈1 min)',
      );
    }
    if (process.env.NOTCHPAY_PRIVATE_KEY && !process.env.NOTCHPAY_WEBHOOK_SECRET) {
      warnings.push(
        'NOTCHPAY_WEBHOOK_SECRET non défini — webhooks NotchPay désactivés ; paiements confirmés par polling (≈1 min)',
      );
    }

    // Firebase (auth sociale/téléphone + notifications push) — mêmes variables
    // que src/config/firebase.ts.
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_CLIENT_EMAIL ||
      !process.env.FIREBASE_PRIVATE_KEY
    ) {
      errors.push(
        'FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY sont requis en production (connexion Google/Apple/téléphone et notifications push)',
      );
    }

    // TLS en transit vers MongoDB/Redis (F23) — fail-closed par défaut : ces deux
    // clients transportent des données financières/PII (soldes, JWT, mots de passe
    // hashés). ALLOW_INSECURE_DB_TLS=true permet un opt-out explicite et documenté
    // pour un déploiement où le TLS est terminé hors bande (VPC privé, stunnel).
    if (process.env.ALLOW_INSECURE_DB_TLS !== 'true') {
      const mongoURI = process.env.MONGODB_URI || '';
      const mongoTlsOk =
        mongoURI.includes('tls=true') ||
        mongoURI.includes('ssl=true') ||
        mongoURI.startsWith('mongodb+srv://');
      if (!mongoTlsOk) {
        errors.push(
          'MONGODB_URI doit utiliser TLS en production (tls=true, ssl=true, ou mongodb+srv://). ' +
            'Définir ALLOW_INSECURE_DB_TLS=true pour un déploiement sur réseau privé de confiance.',
        );
      }

      const redisURL = process.env.REDIS_URL || '';
      if (!redisURL.startsWith('rediss://')) {
        errors.push(
          'REDIS_URL doit utiliser TLS en production (rediss://). ' +
            'Définir ALLOW_INSECURE_DB_TLS=true pour un déploiement sur réseau privé de confiance.',
        );
      }
    }
  }

  // ── Variables recommandées (non-bloquantes) ──
  const recommended = ['METRICS_TOKEN'];
  for (const key of recommended) {
    if (!process.env[key]) {
      warnings.push(`Variable recommandée non définie : ${key}`);
    }
  }

  // Afficher les avertissements
  warnings.forEach((w) => {
    console.warn(`[WARN] ${w}`);
    logger.warn(`[ENV] ${w}`);
  });

  // Bloquer le démarrage si erreurs critiques
  if (errors.length > 0) {
    console.error("FATAL: Validation de l'environnement échouée :");
    errors.forEach((e) => console.error(` ✖ ${e}`));
    logger.error("FATAL: Validation de l'environnement échouée", { errors });
    process.exit(1);
  }

  console.log("[ENV] Validation de l'environnement réussie ✓");
};

validateEnvironment();

// Global Error Handlers (CRITICAL: Capture any crash before/during startup)
process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught Exception:', error);
  if (logger) logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
  if (logger) logger.error('Unhandled Rejection:', { reason, promise });
  process.exit(1);
});

import { initTracing, shutdownTracing } from './config/tracing';
// Initialize OpenTelemetry Tracing
initTracing();

import mongoose from 'mongoose';

import connectDB from './config/database';
import redis from './config/redis';
import { ChallengeService } from './services/challengeService';
import { CronService } from './services/cronService';
import { MonitoringService } from './services/monitoringService';
import { FeatureFlagService } from './services/featureFlagService';
import { seedCountries } from './utils/seedCountries';
import { MigrationService } from './services/migrationService';
import app from './app'; // Keep this import as 'app' is used later
import './config/redis'; // Initialize Redis connection

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    logger.info('Step 1: Connecting to MongoDB...');
    await connectDB();
    logger.info('Step 1: Connected to MongoDB');

    // Seed initial data
    logger.info('Step 2: Seeding data...');
    await seedCountries();
    await ChallengeService.seedChallenges();
    await FeatureFlagService.seed();
    logger.info('Step 2: Data seeded');

    // Run migrations
    logger.info('Step 2.5: Running migrations...');
    await MigrationService.runInitialFintechMigration();
    // runRealMoneyMigration is NOT a startup migration: it wipes simulation data
    // and must only run when an admin actually switches the platform to real
    // money (FeatureFlagService.setRealMoneyMode). Run at startup, it reset
    // every user's goals/challenges/tontines on the next deploy while real
    // money was still off.
    await MigrationService.runTontineRotationMigration();
    await MigrationService.runDisableInvestmentsMigration();
    await MigrationService.runDedupeActiveChallengesMigration();
    await MigrationService.runChallengeTranslationsMigration();
    await MigrationService.runLocalUploadsMigration();
    logger.info('Step 2.5: Migrations completed');

    // Initialize Monitoring (Prometheus)
    logger.info('Step 3: Init Monitoring...');
    MonitoringService.init();

    // Initialize Cron Jobs
    // Prevent multiple executions in PM2 cluster mode by only running on instance 0
    if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
      logger.info('Step 4: Init Cron...');
      CronService.init();
    } else {
      logger.info(
        `Step 4: Skipped Cron init on PM2 cluster instance ${process.env.NODE_APP_INSTANCE}`,
      );
    }

    const server = app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    });

    // --- HIGH CONCURRENCY & STABILITY OPTIMIZATIONS ---

    // 1. Fix intermittent "Connection reset by peer"
    // Must be higher than reverse proxy (Nginx) timeout (default 65s)
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    // 2. Optimization for low latency / high throughput
    server.on('connection', (socket) => {
      socket.setNoDelay(true); // Disable Nagle's algorithm for faster small packet delivery
    });

    // 3. Graceful Shutdown (Essential for stability during deployments)
    const shutdown = (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);
      server.close(() => {
        logger.info('HTTP server closed. Cleaning up resources...');
        // Close DB, Redis, tracing, etc. — all part of this single shutdown
        // sequence (tracing no longer runs its own competing SIGTERM handler,
        // see config/tracing.ts).
        Promise.all([mongoose.connection.close(), redis.quit(), shutdownTracing()])
          .then(() => {
            logger.info('Clean shutdown complete. Exiting.');
            process.exit(0);
          })
          .catch((err) => {
            logger.error('Error during shutdown:', err);
            process.exit(1);
          });
      });

      // Force shutdown after 20s if it takes too long
      setTimeout(() => {
        logger.error('Could not close connections in time, forceful shutdown.');
        process.exit(1);
      }, 20000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
