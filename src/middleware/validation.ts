import { Request, Response, NextFunction } from 'express';
import { Schema } from 'joi';
import { AppError } from './errorHandler';

const validate = (schema: Schema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      allowUnknown: true,
      stripUnknown: true,
    });

    if (error) {
      const errorMessage = error.details.map((details) => details.message).join(', ');
      return next(new AppError(errorMessage, 400));
    }

    // Replace the body with the validated/stripped value so fields not
    // declared in the schema (e.g. role, walletBalance) never reach the
    // service layer, even though allowUnknown is true for backward compat.
    req.body = value;

    next();
  };
};

export default validate;
