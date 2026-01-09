import express from 'express';
import { SystemController } from '../controllers/systemController';

const router = express.Router();

router.get('/version-check', SystemController.checkVersion);
router.get('/public-settings', SystemController.getPublicSettings);

export default router;
