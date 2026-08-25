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

    return `${info.timestamp} ${info.level}: ${info.message}${
      userId ? ` [User: ${userId}]` : ''
    }${requestId ? ` [Req: ${requestId}]` : ''}${ctxLabel ? ` [Context: ${ctxLabel}]` : ''}`;
  }),
);

// Global metadata formatter (Ensures requestId/userId and service metadata are in every log)
const contextFormat = winston.format((info) => {
  const context = RequestContext.getStore();
  if (context) {
    info.requestId = info.requestId || context.requestId;
    info.userId = info.userId || context.userId;
    if (context.context && !info.context) {
      info.context = context.context;
    }
  }
  // Service-level metadata for production-ready structured logging
  if (!info.service) info.service = 'kauri-api';
  if (!info.environment) info.environment = process.env.NODE_ENV || 'development';
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

// Custom Transport for Critical Alerts (Slack/Email)
class CriticalAlertTransport extends Transport {
  constructor(opts?: any) {
    super(opts);
  }

  log(info: any, callback: any) {
    setImmediate(async () => {
      if (process.env.NODE_ENV === 'production' && info.level === 'error') {
        const slackWebhook = process.env.SLACK_ERROR_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;

        // Mask sensitive patterns in error messages & stacks
        const sanitizeText = (text: string): string => {
          if (!text) return '';
          return text
            .replace(/(password|secret|key|token|authorization)\s*[:=]\s*['"]?[^\s,'"]+/gi, '$1: ***MASKED***')
            .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer ***MASKED***');
        };

        const safeMessage = sanitizeText(String(info.message || ''));
        const safeStack = sanitizeText(String(info.stack || 'N/A'));

        // F25: a critical error must reach a human through *some* channel — Slack
        // being unconfigured or unreachable must not mean the alert is simply
        // dropped. slackDelivered tracks whether Slack actually took it so the
        // email fallback only fires when it's genuinely needed.
        let slackDelivered = false;
        if (slackWebhook) {
          try {
            await axios.post(slackWebhook, {
              text: `🚨 *CRITICAL ERROR* \n*Message*: ${safeMessage}\n*Stack*: ${safeStack}\n*Context*: ${JSON.stringify(info.context || {})}`,
            });
            slackDelivered = true;
          } catch (e: any) {
            console.error(`[ALERT] Failed to send Slack alert: ${e.message}`);
          }
        }

        if (!slackDelivered) {
          const adminEmail = process.env.ADMIN_EMAIL;
          if (!adminEmail) {
            console.error(
              '[ALERT] No delivery channel available for a critical error (Slack webhook missing/failed, ADMIN_EMAIL not set) — this alert was NOT delivered anywhere:',
              safeMessage,
            );
          } else {
            try {
              // Dynamic import: EmailService imports this same logger module at
              // its own top level, so a static import here would form a
              // require-cycle. Deferring resolution to first use (well after
              // both modules have finished loading) avoids it.
              const { EmailService } = await import('../services/emailService');
              await EmailService.sendEmail(
                adminEmail,
                '[Kauri] Erreur critique (fallback — Slack indisponible)',
                `${safeMessage}\n\nStack:\n${safeStack}\n\nContext: ${JSON.stringify(info.context || {})}`,
                `<p>${safeMessage}</p><pre>${safeStack}</pre><p>Context: ${JSON.stringify(info.context || {})}</p>`,
              );
            } catch (e: any) {
              console.error(`[ALERT] Email fallback also failed to send: ${e.message}`);
            }
          }
        }
      }
    });
    callback();
  }
}

if (process.env.NODE_ENV === 'production') {
  transports.push(new CriticalAlertTransport({ level: 'error' }) as any);
}

const logger = winston.createLogger({
  level: level(),
  levels,
  format: winston.format.combine(contextFormat(), winston.format.errors({ stack: true })),
  transports,
});

export default logger;
