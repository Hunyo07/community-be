import { Router } from 'express';
import {
  createResident,
  getResidentSelfieId,
  getResidents,
  updateResident,
  updateResidentStatus
} from '../controllers/residentController.js';
import { authorizePermissions } from '../middleware/auth.js';
import { uploadResidentId } from '../middleware/upload.js';
import { PERMISSIONS } from '../rbac/roles.js';

const router = Router();

router.get('/', getResidents);
router.post('/', authorizePermissions(PERMISSIONS.RESIDENTS_WRITE), uploadResidentId.single('selfieWithId'), createResident);
router.get('/:id/selfie-id', authorizePermissions(PERMISSIONS.RESIDENTS_READ), getResidentSelfieId);
router.patch('/:id', authorizePermissions(PERMISSIONS.RESIDENTS_WRITE), uploadResidentId.single('selfieWithId'), updateResident);
router.patch('/:id/status', authorizePermissions(PERMISSIONS.RESIDENTS_WRITE), updateResidentStatus);

export default router;
