import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;
  /** Machine-readable discriminator for clients that need to react to a
   * SPECIFIC error condition (e.g. a genuinely deactivated account) without
   * fragile string-matching on `message`, which is human-readable and can
   * change. Optional — most call sites don't need one. */
  public code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;

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

  // Duplicate key error (unique constraint) — sanitize to prevent schema/PII leakage (F30)
  if (err.code === 11000) {
    const rawField = Object.keys(err.keyValue || {})[0] || 'valeur';
    const fieldMapping: Record<string, string> = {
      email: 'Cette adresse email est déjà enregistrée.',
      phone: 'Ce numéro de téléphone est déjà associé à un compte.',
      inviteCode: "Ce code d'invitation est déjà utilisé.",
      slug: 'Cet identifiant est déjà utilisé.',
    };
    const message = fieldMapping[rawField] || 'Cette ressource ou valeur existe déjà.';
    err = new AppError(message, 409);
  }
  // --------------------------------------------

  if (process.env.NODE_ENV === 'development') {
    logger.error(`Error: ${err.message}`, { stack: err.stack });
    res.status(err.statusCode).json({
      status: err.status,
      error: err,
      message: err.message,
      code: err.code,
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
        code: err.code,
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
