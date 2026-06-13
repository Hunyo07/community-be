import { Router } from 'express';
import { getPublicSettings, listPublicBarangays, listSettings, updateSetting } from '../controllers/settingsController.js';

const router = Router();
export const publicSettingsRoutes = Router();

publicSettingsRoutes.get('/', getPublicSettings);
publicSettingsRoutes.get('/barangays', listPublicBarangays);

router.get('/', listSettings);
router.patch('/:key', updateSetting);

export default router;
