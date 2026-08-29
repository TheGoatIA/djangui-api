import express from 'express';
import { SystemController } from '../controllers/systemController';
import { CountryController } from '../controllers/countryController';
import { identify } from '../middleware/auth';
import { requireClientApiKey } from '../middleware/clientApiKey';

const router = express.Router();

router.use(identify);

router.get('/version-check', SystemController.checkVersion);
router.get('/public-settings', SystemController.getPublicSettings);
router.get('/countries', CountryController.getActiveCountries);
router.post('/telemetry/:type', requireClientApiKey, SystemController.proxyTelemetry);

export default router;
