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

  // --- MongoDB-specific error normalisation ---
  // CastError: invalid ObjectId (e.g. /users/not-an-id)
  if (err.name === 'CastError') {
    err = new AppError(`Identifiant invalide: ${err.value}`, 400);
  }

  // ValidationError: Mongoose schema validation failures
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors)
      .map((e: any) => e.message)
      .join(', ');
    err = new AppError(messages, 400);
  }

  // Duplicate key error (unique constraint)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    err = new AppError(`Cette valeur de '${field}' est déjà utilisée.`, 409);
  }
  // --------------------------------------------

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
