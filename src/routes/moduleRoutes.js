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

// These routers cover shared “module” resources: barangays, offices, requests, staff, and more.
// Each group maps list/create/update handlers from moduleController to a focused URL path.

// Barangay master data used across the app.
export const barangayRoutes = Router();
barangayRoutes.get('/', listModule('barangays'));
barangayRoutes.post('/', authorizePermissions(PERMISSIONS.BARANGAYS_WRITE), createModule('barangays'));
barangayRoutes.patch('/:id', authorizePermissions(PERMISSIONS.BARANGAYS_WRITE), updateModule('barangays'));

// Office records tied to a barangay.
export const officeRoutes = Router();
officeRoutes.get('/', listModule('offices'));
officeRoutes.post('/', authorizePermissions(PERMISSIONS.OFFICES_WRITE), createModule('offices'));
officeRoutes.patch('/:id', authorizePermissions(PERMISSIONS.OFFICES_WRITE), updateModule('offices'));

// Categories that services can be filed under.
export const serviceCategoryRoutes = Router();
serviceCategoryRoutes.get('/', listModule('serviceCategories'));
serviceCategoryRoutes.post('/', authorizePermissions(PERMISSIONS.SERVICE_CATEGORIES_WRITE), createModule('serviceCategories'));
serviceCategoryRoutes.patch('/:id', authorizePermissions(PERMISSIONS.SERVICE_CATEGORIES_WRITE), updateModule('serviceCategories'));

// Document types residents can request (clearance, indigency, etc.).
export const documentTypeRoutes = Router();
documentTypeRoutes.get('/', listModule('documentTypes'));
documentTypeRoutes.post('/', authorizePermissions(PERMISSIONS.DOCUMENT_TYPES_WRITE), createModule('documentTypes'));
documentTypeRoutes.patch('/:id', authorizePermissions(PERMISSIONS.DOCUMENT_TYPES_WRITE), updateModule('documentTypes'));

// Document/service requests and their status workflow.
export const requestRoutes = Router();
requestRoutes.get('/', listModule('requests'));
requestRoutes.post('/', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), createModule('requests'));
requestRoutes.patch('/:id', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), updateRequestDetails);
requestRoutes.patch('/:id/status', authorizePermissions(PERMISSIONS.REQUESTS_WRITE), updateRequestStatus);

// Staff account listing and management.
export const staffRoutes = Router();
staffRoutes.get('/', listStaff);
staffRoutes.post('/', authorizePermissions(PERMISSIONS.STAFF_WRITE), createStaff);
staffRoutes.patch('/:id', authorizePermissions(PERMISSIONS.STAFF_WRITE), updateStaff);

// Community announcements, including poster image upload and delete.
export const announcementRoutes = Router();
announcementRoutes.get('/', listModule('announcements'));
announcementRoutes.get('/:id/poster', getAnnouncementPoster);
announcementRoutes.post('/', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), uploadAnnouncementPoster.single('poster'), createModule('announcements'));
announcementRoutes.patch('/:id', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), uploadAnnouncementPoster.single('poster'), updateModule('announcements'));
announcementRoutes.delete('/:id', authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_WRITE), deleteAnnouncement);

// In-app notifications for the signed-in user.
export const notificationRoutes = Router();
notificationRoutes.get('/', listModule('notifications'));
notificationRoutes.get('/summary', getNotificationSummary);
notificationRoutes.post('/', createModule('notifications'));
notificationRoutes.patch('/read-all', markAllNotificationsRead);
notificationRoutes.patch('/:id/read', markNotificationRead);

// Read-only audit log feed for admins.
export const auditLogRoutes = Router();
auditLogRoutes.get('/', listModule('auditLogs'));
