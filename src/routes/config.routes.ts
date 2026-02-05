import express from 'express';
import { FeatureFlagController } from '../controllers/featureFlagController';

const router = express.Router();

/**
 * @route GET /api/v1/config/features
 * @desc Get all public feature flags
 * @access Public
 */
router.get('/features', FeatureFlagController.getPublicFeatures);

export default router;
