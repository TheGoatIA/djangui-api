import { Router } from 'express';
import { ReportController } from '../controllers/reportController';
import protect from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/dashboard', ReportController.getDashboard);
router.get('/analysis', ReportController.getAnalysis);
router.get('/trends', ReportController.getTrends);
router.get('/narrative', ReportController.getNarrativeReport);
router.get('/export/csv', ReportController.exportCSV);

export default router;
