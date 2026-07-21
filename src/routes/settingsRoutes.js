import { Router } from 'express';
import { getPublicSettings, getPublicStats, listPublicBarangays, listSettings, updateSetting } from '../controllers/settingsController.js';

const router = Router();
export const publicSettingsRoutes = Router();

publicSettingsRoutes.get('/', getPublicSettings);
publicSettingsRoutes.get('/barangays', listPublicBarangays);
publicSettingsRoutes.get('/stats', getPublicStats);

router.get('/', listSettings);
router.patch('/:key', updateSetting);

export default router;
