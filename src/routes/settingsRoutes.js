import { Router } from 'express';
import { getPublicSettings, getPublicStats, listPublicBarangays, listSettings, updateSetting } from '../controllers/settingsController.js';

// These routes manage system settings for admins and expose a few public read-only values.
const router = Router();
export const publicSettingsRoutes = Router();

// Public settings used by the landing/registration pages (no auth required when mounted publicly).
publicSettingsRoutes.get('/', getPublicSettings);
publicSettingsRoutes.get('/barangays', listPublicBarangays);
publicSettingsRoutes.get('/stats', getPublicStats);

// Authenticated admin settings: list all keys or update one by key.
router.get('/', listSettings);
router.patch('/:key', updateSetting);

export default router;
