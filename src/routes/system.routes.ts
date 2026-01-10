import express from 'express';
import { SystemController } from '../controllers/systemController';
import { CountryController } from '../controllers/countryController';

const router = express.Router();

router.get('/version-check', SystemController.checkVersion);
router.get('/public-settings', SystemController.getPublicSettings);
router.get('/countries', CountryController.getActiveCountries);

export default router;
