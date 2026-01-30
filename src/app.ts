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

// Rate limiting using Redis

const app = express();

app.use(
  cors({
    origin: [
      'https://kauri-app.com',
      'https://api.kauri-app.com',
      'https://admin.kauri-app.com',
      'http://localhost:3000',
      'http://localhost:5000',
      'http://localhost:5173',
    ],
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
  store: new RedisStore({
    // @ts-expect-error - Known issue with type definitions
    sendCommand: (...args: string[]) => redis.call(...args),
  }),
});

// Middlewares
app.use(limiter);
app.use(MonitoringService.metricsMiddleware.bind(MonitoringService));
app.use(requestLogger);
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

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
app.use('/api/v1', routes);

// Serve raw Swagger JSON (for Postman Export)
app.get('/api-docs/json', (req, res) => {
  const swaggerFile = path.resolve(__dirname, '../docs/swagger.json');
  try {
    const swaggerContent = fs.readFileSync(swaggerFile, 'utf8');
    res.header('Content-Type', 'application/json');
    res.send(swaggerContent);
  } catch (err) {
    res.status(500).send('Error loading swagger file');
  }
});

// Swagger UI (Dynamic load)
app.use('/api-docs', swaggerUi.serve, (req: any, res: any, next: any) => {
  try {
    const swaggerFile = path.resolve(__dirname, '../docs/swagger.json');
    const swaggerDoc = JSON.parse(fs.readFileSync(swaggerFile, 'utf8'));

    // allow explorer so user can see the URL to the json
    const options = {
      explorer: true,
      swaggerOptions: {
        url: '/api-docs/json',
      },
    };

    swaggerUi.setup(swaggerDoc, options)(req, res, next);
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Kauri API is healthy',
    timestamp: new Date().toISOString(),
  });
});

// Prometheus Metrics Endpoint
app.get('/metrics', MonitoringService.getMetrics.bind(MonitoringService));

// Payment Callbacks (Frontend URL handling)
import { PaymentController } from './controllers/paymentController';
app.get('/payment/success', PaymentController.handlePaymentSuccess);
app.get('/payment/cancel', PaymentController.handlePaymentCancel);

// Error handling
app.use(errorHandler);

export default app;
