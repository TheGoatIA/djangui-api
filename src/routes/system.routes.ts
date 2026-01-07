import express from 'express';
import { SystemController } from '../controllers/systemController';

const router = express.Router();

router.get('/version-check', SystemController.checkVersion);

export default router;
