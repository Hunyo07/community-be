import { Router } from 'express';
import { getHealth } from '../controllers/healthController.js';

// This route exposes a health check so clients can verify the API and database are up.
const router = Router();

router.get('/', getHealth);

export default router;
