import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from './errorHandler';
import User, { IUserDocument } from '../models/User';
import RequestContext from '../utils/context';
import redis from '../config/redis';

export interface AuthRequest extends Request {
  user?: any;
}

/** True when the token was issued before the user's last credential revocation. */
const issuedBeforeRevocation = (iat: number | undefined, user: IUserDocument): boolean => {
  const revokedAt = user.authInvalidatedAt;
  return Boolean(revokedAt && (iat ?? 0) * 1000 < new Date(revokedAt).getTime());
};

const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // 1) Getting token and check if it's there.
    // Mobile sends `Authorization: Bearer <token>`; the admin dashboard relies
    // on the httpOnly `access_token` cookie instead (no header, no JS access to it).
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }

    // 2) Check if token has been explicitly revoked (blacklisted on logout)
    const isBlacklisted = await redis.exists(`blacklist:${token}`);
    if (isBlacklisted) {
      return next(new AppError('Token has been revoked. Please log in again.', 401));
    }

    // 3) Verification token
    // Pin the expected algorithm explicitly: tokens are always signed HS256 (see
    // authService.signToken), and without this option a future code path using an
    // asymmetric key (RS256) alongside the same secret would be vulnerable to an
    // algorithm-confusion attack (a token signed HS256 with the public key as the
    // "secret" would otherwise still verify).
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!, {
      algorithms: ['HS256'],
    }) as {
      id: string;
      iat?: number;
    };

    // 3) Check if user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }

    // 4) Token issued before a password change / reset / "sign out everywhere"
    if (issuedBeforeRevocation(decoded.iat, currentUser)) {
      return next(new AppError('Session expired. Please log in again.', 401));
    }

    // 5) Check if user is active
    if (!currentUser.isActive) {
      return next(new AppError('This user account is deactivated.', 403, 'ACCOUNT_DEACTIVATED'));
    }

    // GRANT ACCESS TO PROTECTED ROUTE
    req.user = currentUser;
    RequestContext.set('userId', currentUser._id.toString());
    next();
  } catch (err) {
    return next(new AppError('Invalid token or expired. Please log in again.', 401));
  }
};

const premiumOnly = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return next(new AppError('Authentication required.', 401));
  }

  // Delegate to the `isPremium` virtual (User.ts) instead of re-checking
  // plan/status/expiry here: this duplicated condition drifted out of sync
  // when the 'business' (Super Premium / Reseller Hub) tier was added — the
  // virtual was updated to treat it as premium, this check wasn't, so
  // business-tier users were wrongly rejected from every premiumOnly route.
  if (!req.user.isPremium) {
    return next(
      new AppError('This is a premium feature. Please upgrade your plan to access it.', 403),
    );
  }

  next();
};

const restrictTo = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError('Authentification requise.', 401));
    }
    // roles ['admin', 'lead-guide']. role='user'
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }

    next();
  };
};

const identify = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.access_token) {
      token = req.cookies.access_token;
    }

    if (!token) return next();

    // Check if token has been revoked (F29)
    const isBlacklisted = await redis.exists(`blacklist:${token}`);
    if (isBlacklisted) return next();

    // Pin the expected algorithm explicitly: tokens are always signed HS256 (see
    // authService.signToken), and without this option a future code path using an
    // asymmetric key (RS256) alongside the same secret would be vulnerable to an
    // algorithm-confusion attack (a token signed HS256 with the public key as the
    // "secret" would otherwise still verify).
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET!, {
      algorithms: ['HS256'],
    }) as {
      id: string;
      iat?: number;
    };

    const currentUser = await User.findById(decoded.id);
    if (!currentUser || !currentUser.isActive) return next();
    if (issuedBeforeRevocation(decoded.iat, currentUser)) return next();

    req.user = currentUser;
    RequestContext.set('userId', currentUser._id.toString());
    next();
  } catch (err) {
    // We don't block, just move to next
    next();
  }
};

export { protect, identify, premiumOnly, restrictTo };
export default protect;
