import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

// Extend Express Request to include user data if present (likely from auth middleware)
interface AuthenticatedRequest extends Request {
  user?: any;
}

export const requestLogger = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const start = Date.now();
  const { method, originalUrl, ip } = req;
  const userAgent = req.get('user-agent') || '';

  // Listen for the response to finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    const userId = req.user ? req.user._id || req.user.id : 'anonymous';

    const logData = {
      message: `${method} ${originalUrl} ${statusCode} ${duration}ms`,
      method,
      url: originalUrl,
      status: statusCode,
      duration,
      ip,
      userAgent,
      userId,
      context: 'AccessLog',
    };

    if (statusCode >= 400) {
      logger.error({ ...logData, message: `FAILED ${logData.message}` });
    } else {
      logger.http(logData);
    }
  });

  next();
};
