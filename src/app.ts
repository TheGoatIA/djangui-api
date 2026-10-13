import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, createRateLimitHandler } from './utils/rateLimitStore';
import redis from './config/redis';
import path from 'node:path';
import fs from 'node:fs';
import errorHandler from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { MonitoringService } from './services/monitoringService';
import routes from './routes';
import swaggerUi from 'swagger-ui-express';
import { currencyMiddleware } from './middleware/currencyMiddleware';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { AuthController } from './controllers/authController';
import { requireClientApiKey } from './middleware/clientApiKey';
import { safeEqual } from './utils/safeCompare';

// Rate limiting using Redis

const app = express();

// The app runs behind a single reverse proxy (see server.ts's keepAliveTimeout/
// headersTimeout comment). Without this, Express derives req.ip from the raw
// socket peer — i.e. the proxy's own address — for every request: the IP-based
// rate limiters below (and req.ip anywhere else, e.g. session/audit logging)
// would then treat every real client as the same "IP", letting one abusive
// client exhaust the shared bucket and locking out everyone else, while also
// making distributed brute-force attempts invisible to per-IP limiting.
app.set('trust proxy', 1);

const productionOrigins = [
  'https://kauri-app.com',
  'https://api.kauri-app.com',
  'https://admin.kauri-app.com',
];

const developmentOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:5173',
];

// ADMIN_URL (required env) and CORS_ALLOWED_ORIGINS (optional, comma-separated)
// let staging / non-default deployments be allowed without a code change.
const toOrigin = (value?: string): string | null => {
  if (!value) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
};
const envOrigins = [
  toOrigin(process.env.ADMIN_URL),
  ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(toOrigin),
].filter((o): o is string => !!o);

const allowedOrigins = [
  ...new Set([
    ...productionOrigins,
    ...envOrigins,
    ...(process.env.NODE_ENV === 'production' ? [] : developmentOrigins),
  ]),
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Client-Type'],
  }),
);

// Rate limiting using Redis
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased limit for admin usage
  message: 'Too many requests from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
  // Use memory store in tests, otherwise use Redis
  store: createRateLimitStore('global'),
  handler: createRateLimitHandler('global'),
});

// Middlewares

// Rate limit FIRST: the raw-body telemetry parser below buffers up to its limit
// per request, so it must never run for a client that is already over budget.
app.use(limiter);

// Telemetry Proxy: Handle raw binary for OTEL before the JSON/urlencoded parsers.
// Important: application/x-protobuf must be treated as a Buffer. inflate: false ensures we proxy compressed data as-is.
// The client key is checked BEFORE the body is read so anonymous callers can't
// make the server buffer megabytes just to be rejected afterwards.
app.use(
  '/api/v1/system/telemetry/traces',
  requireClientApiKey,
  express.raw({
    type: ['application/x-protobuf', 'application/json', '*/*'],
    limit: '2mb',
    inflate: false,
  }),
);

app.use(MonitoringService.metricsMiddleware.bind(MonitoringService));
app.use(requestLogger);
// Per-request CSP nonce so the one legitimate inline <script> left on this app
// (the reset-password deep-link redirect, see AuthController.renderResetPasswordPage)
// can run without `'unsafe-inline'` in script-src — 'unsafe-inline' disables CSP's
// XSS mitigation entirely for every route it applies to, and was previously the
// only thing standing between a token-injection bug on that page and arbitrary
// script execution (the token is now also strictly validated, see authController.ts).
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Strict CSP for all routes — no unsafe-inline
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", (req: any, res: any) => `'nonce-${res.locals.cspNonce}'`],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://validator.swagger.io'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }),
);

// Relaxed CSP only for Swagger UI (requires inline scripts/styles to render)
app.use(
  '/api-docs',
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https://validator.swagger.io'],
      },
    },
  }),
);

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(
  compression({
    // La compression bufferise les chunks avant de les envoyer — exactement
    // ce que le streaming NDJSON du coach (/coach/ask/stream) doit éviter,
    // sinon le client ne recevrait rien avant la fin (ou un remplissage
    // tardif du buffer gzip), annulant l'intérêt du streaming.
    filter: (req, res) => {
      if (req.path.endsWith('/ask/stream')) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(
  express.json({
    limit: '100kb',
    verify: (req: any, res, buf) => {
      // Both webhook signatures must be verified against the exact bytes the
      // provider signed — re-serializing the parsed JSON (JSON.stringify(req.body))
      // isn't guaranteed to byte-match the original (key order, number formatting,
      // unicode escaping can all differ), which would silently reject legitimate
      // webhook deliveries. See utils/cryptoUtils.ts for the NotchPay side.
      if (
        req.originalUrl.includes('/webhooks/stripe') ||
        req.originalUrl.includes('/webhooks/notchpay')
      ) {
        req.rawBody = buf;
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CSRF defence for cookie-authenticated browser sessions (admin dashboard).
// SameSite=Lax alone is not enough: every *.kauri-app.com subdomain is same-site.
// Any state-changing request that authenticates ONLY through the auth cookies
// (no Authorization header) must therefore come from an allowed origin.
// Mobile (Bearer token) and webhooks (no cookies) are unaffected.
app.use((req, res, next) => {
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const usesCookieAuth =
    !req.headers.authorization && (req.cookies?.access_token || req.cookies?.refresh_token);
  if (safeMethod || !usesCookieAuth) return next();

  const origin = req.headers.origin || toOrigin(req.headers.referer);
  if (origin && allowedOrigins.includes(origin)) return next();

  return res.status(403).json({
    status: 'error',
    message: 'Origine de la requête non autorisée.',
  });
});

app.use(currencyMiddleware);

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Kauri API | Excellence Financière</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
        <style>
            :root {
                --primary: #1DB954;
                --primary-dark: #16a34a;
                --accent: #FFD700;
                --bg: #0b0f14;
                --surface: rgba(255, 255, 255, 0.05);
                --text: #f8fafc;
                --text-dim: #94a3b8;
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: 'Outfit', sans-serif;
                background-color: var(--bg);
                color: var(--text);
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                overflow: hidden;
                position: relative;
            }

            /* Animated background blobs */
            .blob {
                position: absolute;
                width: 500px;
                height: 500px;
                background: linear-gradient(135deg, var(--primary), #0a522c);
                filter: blur(80px);
                border-radius: 50%;
                z-index: -1;
                opacity: 0.2;
                animation: flow 20s infinite alternate;
            }

            .blob-1 { top: -200px; left: -100px; }
            .blob-2 { bottom: -200px; right: -100px; animation-delay: -10s; }

            @keyframes flow {
                from { transform: translate(0, 0) scale(1); }
                to { transform: translate(100px, 50px) scale(1.1); }
            }

            .container {
                text-align: center;
                background: var(--surface);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                padding: 3rem;
                border-radius: 2rem;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                max-width: 600px;
                width: 90%;
                animation: fadeIn 1s ease-out;
            }

            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(20px); }
                to { opacity: 1; transform: translateY(0); }
            }

            .logo {
                width: 100px;
                height: 100px;
                background: linear-gradient(135deg, var(--primary), var(--accent));
                margin: 0 auto 2rem;
                border-radius: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 3rem;
                font-weight: 800;
                color: var(--bg);
                box-shadow: 0 10px 30px rgba(29, 185, 84, 0.3);
            }

            h1 {
                font-size: 2.5rem;
                font-weight: 800;
                margin-bottom: 0.5rem;
                background: linear-gradient(to right, #fff, var(--text-dim));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }

            p {
                color: var(--text-dim);
                font-size: 1.1rem;
                line-height: 1.6;
                margin-bottom: 2.5rem;
            }

            .status-badge {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 6px 16px;
                background: rgba(29, 185, 84, 0.1);
                border: 1px solid rgba(29, 185, 84, 0.2);
                border-radius: 100px;
                color: var(--primary);
                font-weight: 600;
                font-size: 0.9rem;
                margin-bottom: 2rem;
            }

            .status-dot {
                width: 8px;
                height: 8px;
                background-color: var(--primary);
                border-radius: 50%;
                box-shadow: 0 0 10px var(--primary);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.5); opacity: 0.5; }
                100% { transform: scale(1); opacity: 1; }
            }

            .actions {
                display: flex;
                gap: 1rem;
                justify-content: center;
            }

            .btn {
                text-decoration: none;
                padding: 0.8rem 1.8rem;
                border-radius: 12px;
                font-weight: 600;
                transition: all 0.3s ease;
                font-size: 1rem;
            }

            .btn-primary {
                background-color: var(--primary);
                color: var(--bg);
            }

            .btn-primary:hover {
                background-color: var(--primary-dark);
                transform: translateY(-2px);
                box-shadow: 0 10px 20px rgba(29, 185, 84, 0.2);
            }

            .btn-secondary {
                background: rgba(255, 255, 255, 0.05);
                color: var(--text);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }

            .btn-secondary:hover {
                background: rgba(255, 255, 255, 0.1);
                transform: translateY(-2px);
            }

            footer {
                margin-top: 3rem;
                color: var(--text-dim);
                font-size: 0.9rem;
                opacity: 0.5;
            }
        </style>
    </head>
    <body>
        <div class="blob blob-1"></div>
        <div class="blob blob-2"></div>

        <div class="container">
            <div class="logo">K</div>
            <h1>Kauri Core API</h1>
            <div class="status-badge">
                <span class="status-dot"></span>
                Système Opérationnel
            </div>
            <p>
                L'infrastructure robuste propulsée par l'intelligence d'Anne pour une liberté financière totale. Scannez, gérez et optimisez vos finances avec une précision inégalée.
            </p>
            
            <div class="actions">
                <a href="/api-docs" class="btn btn-primary">Explorer la Documentation</a>
                <a href="/api/health" class="btn btn-secondary">Santé API</a>
            </div>

            <footer>
                v${require('../package.json').version} &bull; Projets NodeJS &bull; 2026
            </footer>
        </div>
    </body>
    </html>
  `);
});

app.get('/reset-password/:token?', AuthController.renderResetPasswordPage);

// Digital Asset Links / Apple App Site Association: let the mobile app claim
// https://<api>/reset-password/* as a verified link (Android App Links, iOS
// Universal Links) so the reset token never transits the hijackable custom
// scheme kauri://. Values come from the environment — nothing is hardcoded.
app.get('/.well-known/assetlinks.json', (req, res) => {
  const fingerprints = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  if (fingerprints.length === 0) return res.status(404).json({ message: 'Not configured' });
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: process.env.ANDROID_PACKAGE_NAME || 'cm.tbg.kauri',
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

app.get('/.well-known/apple-app-site-association', (req, res) => {
  const appId = (process.env.IOS_APP_ID || '').trim(); // "<TEAM_ID>.cm.tbg.kauri"
  if (!appId) return res.status(404).json({ message: 'Not configured' });
  res.json({
    applinks: {
      apps: [],
      details: [{ appID: appId, paths: ['/reset-password/*'] }],
    },
  });
});

app.use('/api/v1', routes);

// Basic Auth Middleware for Documentation
const swaggerAuth = (req: any, res: any, next: any) => {
  // No fallback: if SWAGGER_PASSWORD is not set the server should not have started
  // (env.ts validates this at boot). If somehow reached, reject safely.
  const swaggerUser = process.env.SWAGGER_USER;
  const swaggerPassword = process.env.SWAGGER_PASSWORD;
  if (!swaggerUser || !swaggerPassword) {
    return res.status(503).send('Documentation unavailable: server misconfigured.');
  }
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const decoded = Buffer.from(b64auth, 'base64').toString();
  // Split on the FIRST colon only: a password may legitimately contain ':'.
  const sep = decoded.indexOf(':');
  const login = sep === -1 ? '' : decoded.slice(0, sep);
  const password = sep === -1 ? '' : decoded.slice(sep + 1);

  if (login && password && safeEqual(login, swaggerUser) && safeEqual(password, swaggerPassword)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Kauri API Documentation"');
  res.status(401).send('Authentication required');
};

// Serve raw Swagger JSON (for Postman Export)
app.get('/api-docs/json', swaggerAuth, (req, res) => {
  const swaggerFile = path.resolve(__dirname, '../docs/swagger.json');
  try {
    const swaggerContent = fs.readFileSync(swaggerFile, 'utf8');
    res.header('Content-Type', 'application/json');
    res.send(swaggerContent);
  } catch (err) {
    res.status(500).send('Error loading swagger file');
  }
});

// Swagger UI Setup
const swaggerOptions = {
  explorer: true,
  swaggerOptions: {
    url: '/api-docs/json',
  },
};

app.use('/api-docs', swaggerAuth, swaggerUi.serve);
app.get('/api-docs', swaggerAuth, (req, res, next) => {
  try {
    const swaggerFile = path.resolve(__dirname, '../docs/swagger.json');
    const swaggerDoc = JSON.parse(fs.readFileSync(swaggerFile, 'utf8'));
    swaggerUi.setup(swaggerDoc, swaggerOptions)(req, res, next);
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', async (req, res) => {
  // Public health check — exposes only operational status, no internal details
  const healthCheck: any = {
    status: 'success',
    timestamp: new Date().toISOString(),
    services: {
      database: { status: 'unknown' },
      cache: { status: 'unknown' },
    },
  };

  // Database check
  healthCheck.services.database.status =
    mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

  // Redis check
  try {
    const pingResponse = await redis.ping();
    healthCheck.services.cache.status = pingResponse === 'PONG' ? 'connected' : 'unhealthy';
  } catch (err) {
    healthCheck.services.cache.status = 'disconnected';
  }

  // Final status
  if (
    healthCheck.services.database.status !== 'connected' ||
    healthCheck.services.cache.status !== 'connected'
  ) {
    healthCheck.status = 'failure';
  }

  const statusCode = healthCheck.status === 'success' ? 200 : 503;
  res.status(statusCode).json(healthCheck);
});

// Prometheus Metrics Endpoint — protected (IP whitelist or internal bearer token)
const metricsAuth = (req: any, res: any, next: any) => {
  const metricsToken = process.env.METRICS_TOKEN;
  const allowedIPs = (process.env.METRICS_ALLOWED_IPS || '127.0.0.1,::1')
    .split(',')
    .map((ip: string) => ip.trim().replace(/^::ffff:/, ''))
    .filter(Boolean);

  // Exact match on the normalised address — a substring test would accept e.g.
  // any IPv6 address ending in '::1'.
  const clientIP = ((req.ip || req.socket?.remoteAddress || '') as string).replace(/^::ffff:/, '');
  const isAllowedIP = allowedIPs.includes(clientIP);

  if (isAllowedIP) return next();

  if (metricsToken) {
    const authHeader = (req.headers.authorization || '') as string;
    if (safeEqual(authHeader, `Bearer ${metricsToken}`)) return next();
    return res.status(403).json({ message: 'Forbidden' });
  }

  // In production without a token configured, block non-whitelisted IPs
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  next();
};

app.get('/metrics', metricsAuth, MonitoringService.getMetrics.bind(MonitoringService));

// Payment Callbacks (Frontend URL handling)
import { PaymentController } from './controllers/paymentController';
app.get('/payment/success', PaymentController.handlePaymentSuccess);
app.get('/payment/cancel', PaymentController.handlePaymentCancel);

// 404 Fallback for unhandled API routes (ensures mobile clients always receive clean JSON instead of HTML)
app.use((req, res, _next) => {
  res.status(404).json({
    status: 'error',
    message: `Route introuvable: ${req.method} ${req.originalUrl}`,
  });
});

// Error handling
app.use(errorHandler);

export default app;
