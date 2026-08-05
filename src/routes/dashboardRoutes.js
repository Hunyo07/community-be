import { Router } from 'express';
import { getDashboard } from '../controllers/dashboardController.js';

// This route returns the dashboard summary metrics for the signed-in user.
const router = Router();

router.get('/', getDashboard);

export default router;
