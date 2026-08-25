import { Request, Response, NextFunction } from 'express';
import FeatureFlag from '../models/FeatureFlag';
import { RedisService } from '../services/redisService';
import { FeatureFlagService } from '../services/featureFlagService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

const FEATURES_CACHE_KEY = 'config:features';
const CACHE_TTL = 3600; // 1 hour

export class FeatureFlagController {
  /**
   * Get all public feature flags mapping
   * GET /api/v1/config/features
   */
  static async getPublicFeatures(req: Request, res: Response, next: NextFunction) {
    try {
      // Try to get from cache
      const cachedFeatures = await RedisService.get<Record<string, any>>(FEATURES_CACHE_KEY);
      if (cachedFeatures) {
        return res.status(200).json({
          status: 'success',
          data: cachedFeatures,
        });
      }

      // If not in cache, fetch from DB
      const flags = await FeatureFlag.find({}).select('slug isEnabled minAppVersion');

      const featuresMap = flags.reduce((acc: Record<string, any>, flag) => {
        acc[flag.slug] = {
          isEnabled: flag.isEnabled,
          minAppVersion: flag.minAppVersion || '1.0.0',
        };
        return acc;
      }, {});

      // Exposed alongside the flags so the mobile client can locally decide
      // whether ITS user's country is currently allowed for real money
      // (e.g. to skip navigating to the wallet at all), without duplicating
      // a hardcoded country literal that would drift from the real,
      // admin-editable allowlist this same value is read from server-side.
      (featuresMap as any).real_money_countries = await FeatureFlagService.getRealMoneyCountries();

      // Save to cache
      await RedisService.set(FEATURES_CACHE_KEY, featuresMap, CACHE_TTL);

      res.status(200).json({
        status: 'success',
        data: featuresMap,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Admin: Get all feature flags with full details
   * GET /api/v1/admin/feature-flags
   */
  static async getAllFlags(req: Request, res: Response, next: NextFunction) {
    try {
      const flags = await FeatureFlag.find({}).sort({ name: 1 });
      res.status(200).json({
        status: 'success',
        data: flags,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Admin: Create a new feature flag
   * POST /api/v1/admin/feature-flags
   */
  static async createFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, slug, isEnabled, description, minAppVersion } = req.body;

      const flag = await FeatureFlag.create({
        name,
        slug,
        isEnabled,
        description,
        minAppVersion,
      });

      // Invalidate cache
      await RedisService.del(FEATURES_CACHE_KEY);

      res.status(201).json({
        status: 'success',
        data: flag,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Admin: Update a feature flag
   * PATCH /api/v1/admin/feature-flags/:id
   */
  static async updateFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const updates = req.body;

      const existing = await FeatureFlag.findById(id);
      if (!existing) {
        return next(new AppError('Feature flag not found', 404));
      }

      // The real-money flag is special-cased: route through
      // FeatureFlagService.setRealMoneyMode so the SystemSetting override
      // (authoritative for FeatureFlagService.isRealMoneyEnabled) stays in
      // sync with this flag document, with a single consolidated notification
      // broadcast — see the equivalent guard in adminController.updateSystemSetting.
      if (existing.slug === 'feat_real_money' && updates.isEnabled !== undefined) {
        await FeatureFlagService.setRealMoneyMode(Boolean(updates.isEnabled), (req as any).user._id);
        const flag = await FeatureFlag.findById(id);
        return res.status(200).json({ status: 'success', data: flag });
      }

      const ALLOWED_FLAG_FIELDS = [
        'name',
        'description',
        'isEnabled',
        'targetRoles',
        'targetCountries',
        'minAppVersion',
        'metadata',
      ];
      const safeUpdates: any = {};
      for (const key of ALLOWED_FLAG_FIELDS) {
        if (key in updates) {
          safeUpdates[key] = updates[key];
        }
      }

      const flag = await FeatureFlag.findByIdAndUpdate(id, safeUpdates, {
        new: true,
        runValidators: true,
      });

      if (!flag) {
        return next(new AppError('Feature flag not found', 404));
      }

      // Invalidate cache
      await RedisService.del(FEATURES_CACHE_KEY);

      res.status(200).json({
        status: 'success',
        data: flag,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Admin: Delete a feature flag
   * DELETE /api/v1/admin/feature-flags/:id
   */
  static async deleteFlag(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const flag = await FeatureFlag.findByIdAndDelete(id);

      if (!flag) {
        return next(new AppError('Feature flag not found', 404));
      }

      // Invalidate cache
      await RedisService.del(FEATURES_CACHE_KEY);

      res.status(204).json({
        status: 'success',
        data: null,
      });
    } catch (error) {
      next(error);
    }
  }
}
