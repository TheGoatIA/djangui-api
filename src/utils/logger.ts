import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import Transport from 'winston-transport';
import axios from 'axios';
import Graylog2 from 'winston-graylog2';

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
  winston.format.printf(
    (info) =>
      `${info.timestamp} ${info.level}: ${info.message}${info.userId ? ` [User: ${info.userId}]` : ''
      }${info.context ? ` [Context: ${info.context}]` : ''}`,
  ),
);

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
if (process.env.GRAYLOG_HOST) {
  transports.push(
    new Graylog2({
      name: 'Graylog',
      level: 'info',
      silent: false,
      handleExceptions: true,
      graylog: {
        servers: [{ host: process.env.GRAYLOG_HOST, port: parseInt(process.env.GRAYLOG_PORT || '12201') }],
        hostname: 'djangui-api',
        facility: 'Node.js',
        bufferSize: 1400,
      },
      staticMeta: { env: process.env.NODE_ENV || 'development' },
    }) as any,
  );
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
        const slackWebhook = process.env.SLACK_WEBHOOK_URL;

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
  transports,
});

export default logger;
