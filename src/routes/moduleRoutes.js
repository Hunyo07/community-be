import { Router } from 'express';
import {
  createModule,
  createStaff,
  deleteAnnouncement,
  getAnnouncementPoster,
  getNotificationSummary,
  listModule,
  listStaff,
  markAllNotificationsRead,
  markNotificationRead,
  updateModule,
  updateRequestDetails,
  updateRequestStatus,
  updateStaff
} from '../controllers/moduleController.js';
import { authorizePermissions } from '../middleware/auth.js';
import { uploadAnnouncementPoster } from '../middleware/upload.js';
import { PERMISSIONS } from '../rbac/roles.js';

export const barangayRoutes = Router();
barangayRoutes.get('/', listModule('barangays'));
barangayRoutes.post('/', authorizePermissions(PERMISSIONS.BARANGAYS_WRITE), createModule('barangays'));
barangayRoutes.patch('/:id', authorizePermissions(PERMISSIONS.BARANGAYS_WRITE), updateModule('barangays'));

export const officeRoutes = Router();
officeRoutes.get('/', listModule('offices'));
officeRoutes.post('/', authorizePermissions(PERMISSIONS.OFFICES_WRITE), createModule('offices'));
officeRoutes.patch('/:id', authorizePermissions(PERMISSIONS.OFFICES_WRITE), updateModule('offices'));

export const serviceCategoryRoutes = Router();
serviceCategoryRoutes.get('/', listModule('serviceCategories'));
serviceCategoryRoutes.post('/', authorizePermissions(PERMISSIONS.SERVICE_CATEGORIES_WRITE), createModule('serviceCategories'));
serviceCategoryRoutes.patch('/:id', authorizePermissions(PERMISSIONS.SERVICE_CATEGORIES_WRITE), updateModule('serviceCategories'));

export const documentTypeRoutes = Router();
documentTypeRoutes.get('/', listModule('documentTypes'));
documentTypeRoutes.post('/', authorizePermissions(PERMISSIONS.DOCUMENT_TYPES_WRITE), createModule('documentTypes'));
documentTypeRoutes.patch('/:id', authorizePermissions(PERMISSIONS.DOCUMENT_TYPES_WRITE), updateModule('documentTypes'));

export const requestRoutes = Router();
requestRoutes.get('/', listModule('requests'));
requestRoutes.post('/', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), createModule('requests'));
requestRoutes.patch('/:id', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), updateRequestDetails);
requestRoutes.patch('/:id/status', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), updateRequestStatus);

export const staffRoutes = Router();
staffRoutes.get('/', listStaff);
staffRoutes.post('/', authorizePermissions(PERMISSIONS.STAFF_WRITE), createStaff);
staffRoutes.patch('/:id', authorizePermissions(PERMISSIONS.STAFF_WRITE), updateStaff);

export const announcementRoutes = Router();
announcementRoutes.get('/', listModule('announcements'));
announcementRoutes.get('/:id/poster', getAnnouncementPoster);
announcementRoutes.post('/', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), uploadAnnouncementPoster.single('poster'), createModule('announcements'));
announcementRoutes.patch('/:id', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), uploadAnnouncementPoster.single('poster'), updateModule('announcements'));
announcementRoutes.delete('/:id', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), deleteAnnouncement);

export const notificationRoutes = Router();
notificationRoutes.get('/', listModule('notifications'));
notificationRoutes.get('/summary', getNotificationSummary);
notificationRoutes.post('/', createModule('notifications'));
notificationRoutes.patch('/read-all', markAllNotificationsRead);
notificationRoutes.patch('/:id/read', markNotificationRead);

export const auditLogRoutes = Router();
auditLogRoutes.get('/', listModule('auditLogs'));
