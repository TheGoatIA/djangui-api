import { Router } from 'express';
import { ReportController } from '../controllers/reportController';
import { protect, premiumOnly } from '../middleware/auth';

const router = Router();

router.use(protect);

router.get('/dashboard', ReportController.getDashboard);
router.get('/analysis', ReportController.getAnalysis);
router.get('/trends', ReportController.getTrends);
router.get('/narrative', premiumOnly, ReportController.getNarrativeReport);
router.get('/health-score-history', premiumOnly, ReportController.getHealthScoreHistory);
router.get('/export/csv', ReportController.exportCSV);

export default router;
