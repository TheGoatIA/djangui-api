import { Request, Response, NextFunction } from 'express';
import { FeatureFlagService } from '../services/featureFlagService';

/**
 * Refuses the request when the feature flag is off (admin-controlled).
 * Used on ENTRY points only (e.g. opening a new investment): users must always
 * be able to see and exit what they already hold.
 */
export const requireFeature =
  (slug: string) => async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (await FeatureFlagService.isEnabled(slug)) return next();
      return res.status(403).json({
        status: 'error',
        code: 'FEATURE_DISABLED',
        message: "Cette fonctionnalité n'est pas disponible pour le moment.",
      });
    } catch (err) {
      next(err);
    }
  };
