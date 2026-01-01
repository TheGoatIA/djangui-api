import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';
import User from '../models/User';
import logger from '../utils/logger';

export interface AuthRequest extends Request {
  user?: any;
}

const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // 1) Getting token and check if it's there
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }

    // 2) Verification token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super-secret') as { id: string };

    // 3) Check if user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }

    // 4) Check if user is active
    if (!currentUser.isActive) {
      return next(new AppError('This user account is deactivated.', 403));
    }

    // GRANT ACCESS TO PROTECTED ROUTE
    req.user = currentUser;
    next();
  } catch (err) {
    return next(new AppError('Invalid token or expired. Please log in again.', 401));
  }
};

export default protect;
