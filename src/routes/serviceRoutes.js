import { Router } from 'express';
import {
  changeServiceStatus,
  createService,
  exportServiceBeneficiariesCsv,
  exportServiceChecklistCsv,
  exportServiceNotYetServedCsv,
  exportServicesSummaryCsv,
  getNotYetServedResidents,
  getServiceDirectory,
  getServedBeneficiaries,
  getServiceChecklist,
  getServiceDetails,
  getServices,
  getServiceSummaryStats,
  resetServiceBeneficiary,
  updateService,
  updateServiceBeneficiary
} from '../controllers/serviceController.js';
import { authorizePermissions } from '../middleware/auth.js';
import { PERMISSIONS } from '../rbac/roles.js';

// These routes manage community services, beneficiary tracking, and CSV exports.
const router = Router();

// Service catalog: list, directory view, and create.
router.get('/', getServices);
router.get('/directory', authorizePermissions(PERMISSIONS.SERVICES_DIRECTORY_READ), getServiceDirectory);
router.post('/', authorizePermissions(PERMISSIONS.SERVICES_WRITE), createService);

// CSV export endpoints for summaries and per-service resident lists.
router.get('/export/summary', exportServicesSummaryCsv);
router.get('/:id/export/checklist', exportServiceChecklistCsv);
router.get('/:id/export/beneficiaries', exportServiceBeneficiariesCsv);
router.get('/:id/export/not-yet-served', exportServiceNotYetServedCsv);

// Per-service details, checklists, beneficiaries, and summary stats.
router.get('/:id/checklist', getServiceChecklist);
router.get('/:id/beneficiaries', getServedBeneficiaries);
router.get('/:id/not-yet-served', getNotYetServedResidents);
router.get('/:id/summary', getServiceSummaryStats);
router.get('/:id', getServiceDetails);

// Update service fields, status, or a single beneficiary record.
router.patch('/:id', authorizePermissions(PERMISSIONS.SERVICES_WRITE), updateService);
router.patch('/:id/status', authorizePermissions(PERMISSIONS.SERVICES_WRITE), changeServiceStatus);
router.patch('/:id/beneficiaries/:residentId', authorizePermissions(PERMISSIONS.SERVICES_WRITE), updateServiceBeneficiary);
router.delete('/:id/beneficiaries/:residentId', authorizePermissions(PERMISSIONS.SERVICES_WRITE), resetServiceBeneficiary);

export default router;
