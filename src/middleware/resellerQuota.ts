import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { AuthRequest } from './auth';
import SharedMasterAccount from '../models/SharedMasterAccount';
import SharedSlot from '../models/SharedSlot';
import { isSubscriptionEntitled } from '../utils/subscription';

export const RESELLER_LIMITS = {
  free: {
    maxAccounts: 2,
    maxSlotsTotal: 3,
    canAutoRemind: false,
    canExport: false,
    hasAdvancedStats: false,
  },
  premium: {
    maxAccounts: 3,
    maxSlotsTotal: 10,
    canAutoRemind: true,
    canExport: false,
    hasAdvancedStats: false,
  },
  business: {
    maxAccounts: Infinity,
    maxSlotsTotal: Infinity,
    canAutoRemind: true,
    canExport: true,
    hasAdvancedStats: true,
  },
};

/**
 * Middleware: Verify account creation quota for reseller's plan tier
 *
 * This is a fast, non-authoritative pre-check — it rejects obviously-over-quota
 * requests early without taking a lock. The actual enforcement (immune to the
 * TOCTOU race a check-then-create like this one has under concurrency) happens
 * again, under a Redis lock, in ResellerService.createMasterAccount/createSlot.
 */
export const checkAccountQuota = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (!user) return next(new AppError('Authentification requise', 401));

    const plan = (user.subscription?.plan as 'free' | 'premium' | 'business') || 'free';
    const limit = RESELLER_LIMITS[plan] || RESELLER_LIMITS.free;

    if (limit.maxAccounts !== Infinity) {
      const currentAccountsCount = await SharedMasterAccount.countDocuments({
        resellerId: user._id,
        status: { $ne: 'expired' },
      });

      if (currentAccountsCount >= limit.maxAccounts) {
        return next(
          new AppError(
            `Limite atteinte : Votre forfait actuel (${plan.toUpperCase()}) ne permet de gérer que ${limit.maxAccounts} compte(s). Passez au forfait Premium ou Business pour en ajouter davantage.`,
            403,
          ),
        );
      }
    }

    next();
  } catch (error: any) {
    next(error);
  }
};

/**
 * Middleware: Verify slot/profile creation quota across all reseller's accounts
 */
export const checkSlotQuota = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    if (!user) return next(new AppError('Authentification requise', 401));

    const plan = (user.subscription?.plan as 'free' | 'premium' | 'business') || 'free';
    const limit = RESELLER_LIMITS[plan] || RESELLER_LIMITS.free;

    if (limit.maxSlotsTotal !== Infinity) {
      const currentSlotsCount = await SharedSlot.countDocuments({
        resellerId: user._id,
        status: { $ne: 'vacant' },
      });

      if (currentSlotsCount >= limit.maxSlotsTotal) {
        return next(
          new AppError(
            `Limite de profils atteinte : Votre forfait (${plan.toUpperCase()}) est limité à ${limit.maxSlotsTotal} profils clients actifs. Mettez à niveau votre compte pour débloquer plus de slots.`,
            403,
          ),
        );
      }
    }

    next();
  } catch (error: any) {
    next(error);
  }
};

/**
 * Middleware: Requires Super Premium (Business tier) for advanced features (e.g. accounting exports)
 */
export const requireBusinessPlan = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) return next(new AppError('Authentification requise', 401));

  // Staff accounts supervise every reseller's accounting from the admin dashboard —
  // that isn't gated by the caller's own consumer subscription tier, only by role.
  if (user.role === 'admin' || user.role === 'support') return next();

  const isBusiness = isSubscriptionEntitled(user.subscription, ['business']);

  if (!isBusiness) {
    return next(
      new AppError(
        'Cette fonctionnalité avancée (exports comptables, statistiques approfondies) est réservée aux abonnés Super Premium (Business).',
        403,
      ),
    );
  }

  next();
};
