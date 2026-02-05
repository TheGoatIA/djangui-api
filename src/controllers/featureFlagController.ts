import { Request, Response, NextFunction } from 'express';
import FeatureFlag from '../models/FeatureFlag';
import { RedisService } from '../services/redisService';
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

            const flag = await FeatureFlag.findByIdAndUpdate(id, updates, {
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
