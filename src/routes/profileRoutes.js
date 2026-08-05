import { Router } from 'express';
import { getMyResidentProfile, updateMyResidentProfile } from '../controllers/residentController.js';
import { authorizePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../rbac/roles.js';

// These routes let a signed-in resident read and update their own profile.
const router = Router();

router.get('/', authorizePermissions(PERMISSIONS.PROFILE_READ), getMyResidentProfile);
router.patch('/', authorizePermissions(PERMISSIONS.PROFILE_WRITE), updateMyResidentProfile);

export default router;
