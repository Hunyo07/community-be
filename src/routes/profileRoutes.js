import { Router } from 'express';
import { getMyResidentProfile, updateMyResidentProfile } from '../controllers/residentController.js';
import { authorizePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../rbac/roles.js';

const router = Router();

router.get('/', authorizePermissions(PERMISSIONS.PROFILE_READ), getMyResidentProfile);
router.patch('/', authorizePermissions(PERMISSIONS.PROFILE_WRITE), updateMyResidentProfile);

export default router;
