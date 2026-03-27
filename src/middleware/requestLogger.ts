import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import RequestContext from '../utils/context';
import { v4 as uuidv4 } from 'uuid';

// Extend Express Request to include user data if present (likely from auth middleware)
interface AuthenticatedRequest extends Request {
  user?: any;
}

/**
 * Sanitize object to remove sensitive data
 */
const sanitize = (obj: any): any => {
  if (!obj || typeof obj !== 'object') return obj;
  const sensitiveKeys = ['password', 'token', 'secret', 'cvv', 'card', 'pin'];
  const sanitized = { ...obj };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      sanitized[key] = '***MASKED***';
    } else if (typeof sanitized[key] === 'object') {
      sanitized[key] = sanitize(sanitized[key]);
    }
  }
  return sanitized;
};

export const requestLogger = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const requestId = uuidv4();
  const start = Date.now();
  const { method, originalUrl, ip } = req;
  const userAgent = req.get('user-agent') || '';

  // Set Request ID in response header for client-side correlation
  res.setHeader('X-Request-Id', requestId);

  // Wrap the entire request lifecycle in RequestContext
  RequestContext.run({ requestId }, () => {
    // Listen for the response to finish
    res.on('finish', () => {
      const duration = Date.now() - start;
      const statusCode = res.statusCode;
      const userId = req.user ? req.user._id || req.user.id : 'anonymous';

      // Update context with userId if it was found during auth middleware
      if (userId !== 'anonymous') {
        RequestContext.set('userId', userId.toString());
      }

      const logData: any = {
        message: `${method} ${originalUrl} ${statusCode} ${duration}ms`,
        method,
        url: originalUrl,
        status: statusCode,
        duration,
        ip,
        userAgent,
        userId: userId.toString(),
        requestId,
        context: 'AccessLog',
      };

      // In development, log request body and query params for debugging.
      // In production, omit body to avoid accidental PII leakage in logs.
      if (process.env.NODE_ENV !== 'production') {
        if (Object.keys(req.query).length > 0) {
          logData.queryParams = sanitize(req.query);
        }
        if (req.body && Object.keys(req.body).length > 0) {
          logData.requestBody = sanitize(req.body);
        }
      }

      if (statusCode >= 400) {
        logger.error({ ...logData, message: `FAILED ${logData.message}` });
      } else {
        logger.http(logData);
      }
    });

    next();
  });
};
