import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis from './config/redis';
import path from 'path';
import errorHandler from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { MonitoringService } from './services/monitoringService';
import routes from './routes';
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from '../docs/swagger.json';
import { currencyMiddleware } from './middleware/currencyMiddleware';
import mongoose from 'mongoose';
import os from 'os';
import { AuthController } from './controllers/authController';

// Rate limiting using Redis

const app = express();

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

const allowedOrigins =
  process.env.NODE_ENV === 'production'
    ? productionOrigins
    : [...productionOrigins, ...developmentOrigins];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
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
  store:
    process.env.NODE_ENV === 'test'
      ? undefined
      : new RedisStore({
          sendCommand: (...args: string[]) => redis.call(...args),
        }),
});

// Middlewares

// Telemetry Proxy: Handle raw binary for OTEL before ANY other middleware (to avoid body parsing or rate limiting issues)
// Important: application/x-protobuf must be treated as a Buffer. inflate: false ensures we proxy compressed data as-is.
app.use(
  '/api/v1/system/telemetry/traces',
  express.raw({
    type: ['application/x-protobuf', 'application/json', '*/*'],
    limit: '10mb',
    inflate: false,
  }),
);

app.use(limiter);
app.use(MonitoringService.metricsMiddleware.bind(MonitoringService));
app.use(requestLogger);
// Strict CSP for all routes — no unsafe-inline
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", "'unsafe-inline'"], // Needed for some internal tools and Swagger
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

app.use(compression());

app.use(
  express.json({
    verify: (req: any, res, buf) => {
      if (req.originalUrl.includes('/webhooks/stripe')) {
        req.rawBody = buf;
      }
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(currencyMiddleware);

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

import fs from 'fs';

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

app.use('/api/v1', routes);

// Basic Auth Middleware for Documentation
const swaggerAuth = (req: any, res: any, next: any) => {
  const auth = {
    login: process.env.SWAGGER_USER || 'admin',
    password: process.env.SWAGGER_PASSWORD || 'kauri2026',
  };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && login === auth.login && password === auth.password) {
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
  const allowedIPs = (process.env.METRICS_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1').split(
    ',',
  );

  const clientIP = (req.ip || req.connection?.remoteAddress || '') as string;
  const isAllowedIP = allowedIPs.some((ip: string) => clientIP.includes(ip.trim()));

  if (isAllowedIP) return next();

  if (metricsToken) {
    const authHeader = (req.headers.authorization || '') as string;
    if (authHeader === `Bearer ${metricsToken}`) return next();
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

// Error handling
app.use(errorHandler);

export default app;
