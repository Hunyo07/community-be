import { Router } from 'express';
import { getReport } from '../controllers/reportController.js';

// Report endpoints return filtered tabular data for the Reports page.
const router = Router();

router.get('/:type', getReport);

export default router;
