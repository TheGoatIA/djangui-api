import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    logger.error(`Error: ${err.message}`, { stack: err.stack });
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      stack: err.stack,
    });
  } else {
    // Production
    if (err.isOperational) {
      // We still log operational errors for tracking, but with a warning level
      logger.warn(`Operational Error: ${err.message}`, {
        statusCode: err.statusCode,
        status: err.status,
      });
      res.status(err.statusCode).json({
        status: err.status,
        message: err.message,
      });
    } else {
      // Critical error
      logger.error(`Critical Error: ${err.message}`, {
        stack: err.stack,
        originalError: err,
      });
      res.status(500).json({
        status: 'error',
        message: 'Something went very wrong!',
      });
    }
  }
};

export default errorHandler;
