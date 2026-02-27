import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import Transport from 'winston-transport';
import axios from 'axios';
import Graylog2 from 'winston-graylog2';
import RequestContext from './context';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const level = () => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'info'; // Changed 'warn' to 'info' to see more logs in prod
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

// Define log format for files (JSON is better for parsing/stats)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.json(),
);

// Define log format for console (Readable)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const context = RequestContext.getStore();
    const requestId = info.requestId || context?.requestId;
    const userId = info.userId || context?.userId;
    const ctxLabel = info.context || context?.context;

    return `${info.timestamp} ${info.level}: ${info.message}${userId ? ` [User: ${userId}]` : ''
      }${requestId ? ` [Req: ${requestId}]` : ''}${ctxLabel ? ` [Context: ${ctxLabel}]` : ''}`;
  }),
);

// Global metadata formatter (Ensures requestId/userId are always in the metadata object)
const contextFormat = winston.format((info) => {
  const context = RequestContext.getStore();
  if (context) {
    info.requestId = info.requestId || context.requestId;
    info.userId = info.userId || context.userId;
    if (context.context && !info.context) {
      info.context = context.context;
    }
  }
  return info;
});

const transports = [
  // Console Transport
  new winston.transports.Console({
    format: consoleFormat,
  }),
  // Error Logs - Daily Rotation
  new winston.transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level: 'error',
    format: fileFormat,
  }),
  // All Logs - Daily Rotation (for stats/sessions)
  new winston.transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d', // Keep 30 days of history for stats
    format: fileFormat,
  }),
];

// Graylog Transport
// Graylog Transport - Disabled temporarily due to DNS crash on startup

if (process.env.GRAYLOG_HOST && process.env.GRAYLOG_HOST !== 'disabled') {
  try {
    transports.push(
      new Graylog2({
        name: 'Graylog',
        level: 'info',
        silent: false,
        handleExceptions: true,
        graylog: {
          servers: [
            { host: process.env.GRAYLOG_HOST, port: parseInt(process.env.GRAYLOG_PORT || '12201') },
          ],
          hostname: 'kauri-api',
          facility: 'Node.js',
          bufferSize: 1400,
        },
        staticMeta: { env: process.env.NODE_ENV || 'development' },
      }) as any,
    );
  } catch (err) {
    console.error('Failed to initialize Graylog transport:', err);
  }
}

// Custom Transport for Email Alerts (Critical Errors)
class EmailAlertTransport extends Transport {
  constructor(opts?: any) {
    super(opts);
  }

  log(info: any, callback: any) {
    setImmediate(async () => {
      if (process.env.NODE_ENV === 'production' && info.level === 'error') {
        // To avoid circular dependency with EmailService, we use a simple fetch/axios if Mailgun is direct,
        // or we emit an event that a service listens to.
        // For simplicity here, we'll try to use a direct Mailgun hit if possible or just log a reminder.
        // Actually, let's keep it simple: inform that critical alerts should be sent.
        // In a real scenario, we'd use a dedicated alerting service (like Sentry or a simple webhook).

        const adminEmail = process.env.ADMIN_EMAIL || 'me@borisgauty.com';
        const slackWebhook = process.env.SLACK_ERROR_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

        if (slackWebhook) {
          try {
            await axios.post(slackWebhook, {
              text: `🚨 *CRITICAL ERROR* \n*Message*: ${info.message}\n*Stack*: ${info.stack || 'N/A'}\n*Context*: ${JSON.stringify(info.context || {})}`,
            });
          } catch (e) {
            // Silence
          }
        }
      }
    });
    callback();
  }
}

if (process.env.NODE_ENV === 'production') {
  transports.push(new EmailAlertTransport({ level: 'error' }) as any);
}

const logger = winston.createLogger({
  level: level(),
  levels,
  format: winston.format.combine(contextFormat(), winston.format.errors({ stack: true })),
  transports,
});

export default logger;
