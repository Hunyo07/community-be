import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../config/db.js';
import { emitRealtimeEvent } from '../realtime/socket.js';
import { normalizePermissions } from '../rbac/roles.js';
import { logAudit } from '../utils/auditLogger.js';
import { hashPassword } from '../utils/password.js';
import { isSettingEnabled } from '../utils/settings.js';

// This controller powers shared “module” APIs: barangays, offices, requests, staff, and more.
// Factory handlers (listModule, createModule, updateModule) reuse one tableMap config per resource.

// Builds the user id/role pair used to decide which notifications belong to someone.
const getNotificationAudience = (user) => ({
  userId: user?.id || 0,
  userRole: user?.role || user?.accountType || 'resident'
});

// SQL scope so users only see their own notifications (or broadcast ones for their role).
const getNotificationScope = (user, tableAlias = '') => {
  const { userId, userRole } = getNotificationAudience(user);
  const prefix = tableAlias ? `${tableAlias}.` : '';

  return {
    clause: `(${prefix}user_id = ? AND ${prefix}user_role = ?)
      OR (${prefix}user_id IS NULL AND ${prefix}user_role IN (?, 'all', 'All'))`,
    values: [userId, userRole, userRole]
  };
};

const normalizeBarangayName = (barangay = '') =>
  String(barangay)
    .trim()
    .replace(/^barangay\s+/i, '')
    .toLowerCase();

const barangayMatchSql = (columnName) => `LOWER(TRIM(REPLACE(REPLACE(${columnName}, 'Barangay ', ''), 'barangay ', ''))) =
  LOWER(TRIM(REPLACE(REPLACE(?, 'Barangay ', ''), 'barangay ', '')))`;

// Loads the current user's barangay from resident or staff tables when needed.
const getCurrentUserBarangay = async (user) => {
  if (!user?.id) return user?.barangay || null;

  if (user.accountType === 'resident') {
    const [[resident]] = await pool.execute('SELECT barangay FROM resident_accounts WHERE id = ?', [user.id]);
    return resident?.barangay || user.barangay || null;
  }

  if (user.accountType === 'staff') {
    const [[staff]] = await pool.execute('SELECT barangay FROM staff_accounts WHERE id = ?', [user.id]);
    return staff?.barangay || user.barangay || null;
  }

  return user.barangay || null;
};

const announcementSelect = `SELECT id, title, content, poster_image AS posterImage, audience, barangay, category, priority, pinned, status,
  published_at AS publishedAt, expires_at AS expiresAt, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
  FROM announcements`;

// Fills announcement fields with defaults from the body, existing row, and signed-in user.
const normalizeAnnouncementPayload = (body, user, existing = {}) => ({
  title: body.title ?? existing.title,
  content: body.content ?? existing.content ?? '',
  posterImage: body.posterImage ?? existing.posterImage ?? null,
  audience: body.audience ?? existing.audience ?? 'All',
  barangay: body.barangay === '' ? null : body.barangay ?? existing.barangay ?? null,
  category: body.category ?? existing.category ?? 'Advisory',
  priority: body.priority ?? existing.priority ?? 'Normal',
  pinned: body.pinned === true || body.pinned === 1 || body.pinned === '1' || body.pinned === 'true',
  status: body.status ?? existing.status ?? 'Draft',
  expiresAt: body.expiresAt === '' ? null : body.expiresAt ?? existing.expiresAt ?? null,
  createdBy: existing.createdBy ?? user?.id ?? null,
  createdByName: existing.createdByName ?? user?.name ?? ''
});

// Creates in-app notifications for matching residents when an announcement is published.
const createAnnouncementNotifications = async (announcement) => {
  if (announcement.status !== 'Published' || !['All', 'Residents'].includes(announcement.audience)) return;

  const values = [];
  const filters = ["verification_status = 'Verified'", "account_status = 'Active'"];
  if (announcement.barangay) {
    filters.push('barangay = ?');
    values.push(announcement.barangay);
  }

  const [residents] = await pool.execute(
    `SELECT id FROM resident_accounts WHERE ${filters.join(' AND ')}`,
    values
  );

  if (!residents.length) return;

  await pool.query(
    `INSERT INTO notifications (user_id, user_role, title, message)
     VALUES ?`,
    [
      residents.map((resident) => [
        resident.id,
        'resident',
        'New announcement',
        announcement.priority === 'Urgent' ? `Urgent: ${announcement.title}` : announcement.title
      ])
    ]
  );
  emitRealtimeEvent('notifications:changed', { action: 'created', userRole: 'resident' });
};

// Per-module SQL config: list/insert/update queries and realtime event names.
const tableMap = {
  barangays: {
    table: 'barangays',
    realtime: 'barangays:changed',
    list: `SELECT id, name, captain, contact, status, created_at AS createdAt FROM barangays ORDER BY name ASC`,
    insert: {
      sql: `INSERT INTO barangays (name, captain, contact, status) VALUES (?, ?, ?, ?)`,
      values: (body) => [body.name, body.captain || '', body.contact || '', body.status || 'Active']
    },
    update: {
      sql: `UPDATE barangays SET name = ?, captain = ?, contact = ?, status = ? WHERE id = ?`,
      values: (body, id) => [body.name, body.captain || '', body.contact || '', body.status || 'Active', id]
    }
  },
  offices: {
    table: 'offices',
    realtime: 'offices:changed',
    list: `SELECT id, name, barangay, description, status, created_at AS createdAt FROM offices ORDER BY barangay ASC, name ASC`,
    insert: {
      sql: `INSERT INTO offices (name, barangay, description, status) VALUES (?, ?, ?, ?)`,
      values: (body) => [body.name, body.barangay, body.description || '', body.status || 'Active']
    },
    update: {
      sql: `UPDATE offices SET name = ?, barangay = ?, description = ?, status = ? WHERE id = ?`,
      values: (body, id) => [body.name, body.barangay, body.description || '', body.status || 'Active', id]
    }
  },
  serviceCategories: {
    table: 'service_categories',
    realtime: 'service-categories:changed',
    list: `SELECT id, name, description, status, created_at AS createdAt FROM service_categories ORDER BY name ASC`,
    insert: {
      sql: `INSERT INTO service_categories (name, description, status) VALUES (?, ?, ?)`,
      values: (body) => [body.name, body.description || '', body.status || 'Active']
    },
    update: {
      sql: `UPDATE service_categories SET name = ?, description = ?, status = ? WHERE id = ?`,
      values: (body, id) => [body.name, body.description || '', body.status || 'Active', id]
    }
  },
  documentTypes: {
    table: 'document_types',
    realtime: 'document-types:changed',
    list: `SELECT id, name, description, status, created_at AS createdAt FROM document_types ORDER BY name ASC`,
    insert: {
      sql: `INSERT INTO document_types (name, description, status) VALUES (?, ?, ?)`,
      values: (body) => [body.name, body.description || '', body.status || 'Active']
    },
    update: {
      sql: `UPDATE document_types SET name = ?, description = ?, status = ? WHERE id = ?`,
      values: (body, id) => [body.name, body.description || '', body.status || 'Active', id]
    }
  },
  requests: {
    table: 'service_requests',
    realtime: 'requests:changed',
    list: ({ user }) => {
      const filters = [];
      const values = [];

      if (user?.accountType === 'resident') {
        filters.push('sr.resident_id = ?');
        values.push(user.id);
      }

      if (user?.role === 'barangay_staff') {
        filters.push('ra.barangay = ?');
        values.push(user.barangay || '');
      }

      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

      return {
        sql: `SELECT sr.id, sr.resident_id AS residentId, sr.document_type_id AS documentTypeId,
                sr.title, sr.description, sr.status, sr.created_at AS createdAt,
                CONCAT(ra.first_name, ' ', ra.last_name) AS residentName, ra.barangay AS residentBarangay,
                dt.name AS documentTypeName
              FROM service_requests sr
              LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
              LEFT JOIN document_types dt ON dt.id = sr.document_type_id
              ${where}
              ORDER BY sr.created_at DESC`,
        values
      };
    },
    insert: {
      sql: `INSERT INTO service_requests (resident_id, service_id, document_type_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values: (body, user) => [
        body.residentId || (user?.accountType === 'resident' ? user.id : null),
        null,
        body.documentTypeId || null,
        body.title,
        body.description || '',
        body.status || 'Submitted',
        'Normal'
      ]
    }
  },
  announcements: {
    table: 'announcements',
    realtime: 'announcements:changed',
    list: async ({ user }) => {
      const filters = [];
      const values = [];
      const currentBarangay = await getCurrentUserBarangay(user);

      if (!user?.permissions?.includes('announcements:write')) {
        filters.push("status = 'Published'");
        filters.push('(expires_at IS NULL OR expires_at >= NOW())');

        const audience = user?.role === 'resident' ? 'Residents' : user?.role === 'barangay_staff' ? 'Barangay Staff' : 'Admins';
        filters.push('(audience = ? OR audience = ?)');
        values.push('All', audience);

        if (currentBarangay) {
          filters.push(`(barangay IS NULL OR barangay = '' OR ${barangayMatchSql('barangay')})`);
          values.push(currentBarangay);
        } else {
          filters.push('barangay IS NULL');
        }
      }

      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      return {
        sql: `${announcementSelect}
              ${where}
              ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC`,
        values
      };
    },
    insert: {
      sql: `INSERT INTO announcements
        (title, content, poster_image, audience, barangay, category, priority, pinned, status, published_at, expires_at, created_by, created_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: (body, user) => {
        const payload = normalizeAnnouncementPayload(body, user);
        return [
          payload.title,
          payload.content,
          payload.posterImage,
          payload.audience,
          payload.barangay,
          payload.category,
          payload.priority,
          payload.pinned ? 1 : 0,
          payload.status,
          payload.status === 'Published' ? new Date() : null,
          payload.expiresAt,
          payload.createdBy,
          payload.createdByName
        ];
      }
    },
    update: {
      sql: `UPDATE announcements
            SET title = ?, content = ?, poster_image = COALESCE(?, poster_image), audience = ?, barangay = ?, category = ?, priority = ?, pinned = ?, status = ?, expires_at = ?, published_at = CASE
              WHEN ? = 'Published' AND published_at IS NULL THEN CURRENT_TIMESTAMP
              WHEN ? != 'Published' THEN NULL
              ELSE published_at
            END
            WHERE id = ?`,
      values: (body, id) => {
        const payload = normalizeAnnouncementPayload(body, null);
        return [
          payload.title,
          payload.content,
          payload.posterImage,
          payload.audience,
          payload.barangay,
          payload.category,
          payload.priority,
          payload.pinned ? 1 : 0,
          payload.status,
          payload.expiresAt,
          payload.status,
          payload.status,
          id
        ];
      }
    }
  },
  notifications: {
    table: 'notifications',
    realtime: 'notifications:changed',
    list: ({ user }) => {
      const scope = getNotificationScope(user);

      return {
        sql: `SELECT id, user_id AS userId, user_role AS userRole, title, message, read_at AS readAt, created_at AS createdAt
              FROM notifications
              WHERE ${scope.clause}
              ORDER BY created_at DESC`,
        values: scope.values
      };
    },
    insert: {
      sql: `INSERT INTO notifications (user_id, user_role, title, message) VALUES (?, ?, ?, ?)`,
      values: (body) => [body.userId || null, body.userRole || 'resident', body.title, body.message || '']
    }
  },
  auditLogs: {
    table: 'audit_logs',
    realtime: 'audit:changed',
    list: `SELECT id, user_id AS userId, user_role AS userRole, action, entity_type AS entityType, entity_id AS entityId, details, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT 100`
  }
};

// Factory: returns a handler that lists records for the named module.
export const listModule = (moduleName) => async (req, res, next) => {
  try {
    const config = tableMap[moduleName];
    const queryConfig = typeof config.list === 'function' ? await config.list({ user: req.user }) : { sql: config.list, values: [] };
    const [rows] = await pool.execute(queryConfig.sql, queryConfig.values || []);
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
};

// Factory: returns a handler that inserts a new row for the named module.
export const createModule = (moduleName) => async (req, res, next) => {
  try {
    const config = tableMap[moduleName];
    if (moduleName === 'announcements' && req.file?.path) {
      req.body.posterImage = req.file.path;
    }

    if (moduleName === 'requests') {
      const documentTypeId = Number(req.body.documentTypeId || 0);
      if (!documentTypeId) {
        return res.status(400).json({ message: 'Document type is required' });
      }

      const [documentTypes] = await pool.execute('SELECT id, name, status FROM document_types WHERE id = ?', [documentTypeId]);
      if (!documentTypes.length || documentTypes[0].status !== 'Active') {
        return res.status(400).json({ message: 'Selected document type is not available' });
      }

      req.body.documentTypeId = documentTypeId;
      req.body.serviceId = null;
      req.body.title = documentTypes[0].name;
      req.body.status = 'Submitted';
    }

    const [result] = await pool.execute(config.insert.sql, config.insert.values(req.body, req.user));
    const createdRecord = { id: result.insertId, ...req.body };

    await logAudit({
      user: req.user,
      action: `${moduleName}.create`,
      entityType: config.table,
      entityId: result.insertId,
      details: req.body
    });
    emitRealtimeEvent(config.realtime, { action: 'created', id: result.insertId });
    emitRealtimeEvent('dashboard:changed', { reason: `${moduleName}-created` });

    if (moduleName === 'announcements' && req.body.status === 'Published') {
      await createAnnouncementNotifications(createdRecord);
    }

    if (
      moduleName === 'requests' &&
      req.user?.accountType === 'resident' &&
      (await isSettingEnabled('request_auto_notifications', true))
    ) {
      await pool.execute(
        `INSERT INTO notifications (user_id, user_role, title, message)
         VALUES (?, 'resident', ?, ?)`,
        [
          req.user.id,
          'Document request submitted',
          `Your ${req.body.title} request was submitted and is waiting for review.`
        ]
      );
      emitRealtimeEvent('notifications:changed', { action: 'created', userId: req.user.id, userRole: 'resident' });
    }

    return res.status(201).json({ data: createdRecord });
  } catch (error) {
    return next(error);
  }
};

// Factory: returns a handler that updates an existing row for the named module.
export const updateModule = (moduleName) => async (req, res, next) => {
  try {
    const config = tableMap[moduleName];
    if (moduleName === 'announcements' && req.file?.path) {
      req.body.posterImage = req.file.path;
    }

    if (!config.update) {
      return res.status(405).json({ message: 'This module does not support updates' });
    }

    const [result] = await pool.execute(config.update.sql, config.update.values(req.body, req.params.id, req.user));
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Record not found' });

    await logAudit({
      user: req.user,
      action: `${moduleName}.update`,
      entityType: config.table,
      entityId: req.params.id,
      details: req.body
    });
    emitRealtimeEvent(config.realtime, { action: 'updated', id: req.params.id });
    emitRealtimeEvent('dashboard:changed', { reason: `${moduleName}-updated` });

    if (moduleName === 'announcements' && req.body.status === 'Published') {
      await createAnnouncementNotifications({ id: req.params.id, ...req.body });
    }

    return res.json({ data: { id: req.params.id, ...req.body } });
  } catch (error) {
    return next(error);
  }
};

// Moves a document request through its status workflow and notifies the resident.
export const updateRequestStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['Submitted', 'Under Review', 'Approved', 'Rejected', 'Processing', 'Completed', 'Claimed', 'Cancelled'];

    if (req.user?.accountType === 'resident' && status !== 'Cancelled') {
      return res.status(403).json({ message: 'Residents can submit requests but cannot update request status' });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid request status' });
    }

    const [currentRows] = await pool.execute(
      `SELECT sr.id, sr.resident_id AS residentId, sr.title, sr.status, ra.barangay
       FROM service_requests sr
       LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
       WHERE sr.id = ?`,
      [req.params.id]
    );

    if (currentRows.length === 0) return res.status(404).json({ message: 'Request not found' });
    const currentRequest = currentRows[0];

    if (req.user?.accountType === 'resident') {
      if (currentRequest.residentId !== req.user.id) {
        return res.status(403).json({ message: 'You can only update your own requests' });
      }

      if (currentRequest.status !== 'Submitted') {
        return res.status(400).json({ message: 'Only submitted requests can be cancelled by residents' });
      }
    }

    if (status === 'Claimed' && currentRequest.status !== 'Completed') {
      return res.status(400).json({ message: 'Only ready-to-claim requests can be marked as claimed' });
    }

    if (req.user?.role === 'barangay_staff') {
      const sameBarangay = currentRequest.barangay === req.user.barangay;
      if (!sameBarangay) {
        return res.status(403).json({ message: 'You do not have permission to update this request' });
      }
    }

    const [result] = await pool.execute('UPDATE service_requests SET status = ? WHERE id = ?', [status, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Request not found' });

    if (currentRequest.residentId && (await isSettingEnabled('request_auto_notifications', true))) {
      await pool.execute(
        `INSERT INTO notifications (user_id, user_role, title, message)
         VALUES (?, 'resident', ?, ?)`,
        [
          currentRequest.residentId,
          'Document request status updated',
          status === 'Completed'
            ? `Your ${currentRequest.title} request is ready. Please claim your document at your barangay office.`
            : status === 'Claimed'
              ? `Your ${currentRequest.title} request has been marked as claimed.`
              : `Your ${currentRequest.title} request is now ${status}.`
        ]
      );
      emitRealtimeEvent('notifications:changed', {
        action: 'created',
        userId: currentRequest.residentId,
        userRole: 'resident'
      });
    }

    await logAudit({ user: req.user, action: 'requests.status_update', entityType: 'service_requests', entityId: req.params.id, details: { status } });
    emitRealtimeEvent('requests:changed', { action: 'status-updated', id: req.params.id, status });
    emitRealtimeEvent('dashboard:changed', { reason: 'request-status-updated' });

    return res.json({ data: { id: req.params.id, status } });
  } catch (error) {
    return next(error);
  }
};

// Lets residents or staff edit request title/description while still submitted.
export const updateRequestDetails = async (req, res, next) => {
  try {
    const { title, description = '' } = req.body;

    if (!title) {
      return res.status(400).json({ message: 'Request title is required' });
    }

    const [currentRows] = await pool.execute(
      `SELECT id, resident_id AS residentId, status
       FROM service_requests
       WHERE id = ?`,
      [req.params.id]
    );

    if (currentRows.length === 0) return res.status(404).json({ message: 'Request not found' });
    const currentRequest = currentRows[0];

    if (req.user?.accountType === 'resident') {
      if (currentRequest.residentId !== req.user.id) {
        return res.status(403).json({ message: 'You can only edit your own requests' });
      }

      if (currentRequest.status !== 'Submitted') {
        return res.status(400).json({ message: 'Only submitted requests can be edited' });
      }
    }

    await pool.execute(
      `UPDATE service_requests
       SET title = ?, description = ?
       WHERE id = ?`,
      [title, description, req.params.id]
    );

    await logAudit({
      user: req.user,
      action: 'requests.update',
      entityType: 'service_requests',
      entityId: req.params.id,
      details: { title, description }
    });
    emitRealtimeEvent('requests:changed', { action: 'updated', id: req.params.id });
    emitRealtimeEvent('dashboard:changed', { reason: 'request-updated' });

    return res.json({ data: { id: req.params.id, title, description } });
  } catch (error) {
    return next(error);
  }
};

// Marks a single notification as read for the signed-in user.
export const markNotificationRead = async (req, res, next) => {
  try {
    const scope = getNotificationScope(req.user);

    const [result] = await pool.execute(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (${scope.clause})`,
      [req.params.id, ...scope.values]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    await logAudit({
      user: req.user,
      action: 'notifications.mark_read',
      entityType: 'notifications',
      entityId: req.params.id
    });
    emitRealtimeEvent('notifications:changed', { action: 'read', id: req.params.id, userId: req.user?.id, userRole: req.user?.role });

    return res.json({ data: { id: req.params.id, readAt: new Date().toISOString() } });
  } catch (error) {
    return next(error);
  }
};

// Returns total and unread notification counts for the signed-in user.
export const getNotificationSummary = async (req, res, next) => {
  try {
    const scope = getNotificationScope(req.user);

    const [[summary]] = await pool.execute(
      `SELECT
        COUNT(*) AS total,
        SUM(read_at IS NULL) AS unread
       FROM notifications
       WHERE ${scope.clause}`,
      scope.values
    );

    return res.json({
      data: {
        total: Number(summary.total || 0),
        unread: Number(summary.unread || 0)
      }
    });
  } catch (error) {
    return next(error);
  }
};

// Marks every unread notification in the user's scope as read.
export const markAllNotificationsRead = async (req, res, next) => {
  try {
    const scope = getNotificationScope(req.user);

    const [result] = await pool.execute(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE read_at IS NULL AND (${scope.clause})`,
      scope.values
    );

    await logAudit({
      user: req.user,
      action: 'notifications.mark_all_read',
      entityType: 'notifications',
      details: { affectedRows: result.affectedRows }
    });
    emitRealtimeEvent('notifications:changed', { action: 'all-read', userId: req.user?.id, userRole: req.user?.role });

    return res.json({ data: { updated: result.affectedRows } });
  } catch (error) {
    return next(error);
  }
};

// Deletes an announcement by id and notifies connected clients.
export const deleteAnnouncement = async (req, res, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM announcements WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Announcement not found' });

    await logAudit({
      user: req.user,
      action: 'announcements.delete',
      entityType: 'announcements',
      entityId: req.params.id
    });
    emitRealtimeEvent('announcements:changed', { action: 'deleted', id: req.params.id });
    emitRealtimeEvent('dashboard:changed', { reason: 'announcement-deleted' });

    return res.json({ data: { id: req.params.id, deleted: true } });
  } catch (error) {
    return next(error);
  }
};

// Streams an announcement poster image after checking audience and barangay access.
export const getAnnouncementPoster = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, title, poster_image AS posterImage, audience, barangay, status, expires_at AS expiresAt
       FROM announcements
       WHERE id = ?`,
      [req.params.id]
    );

    if (rows.length === 0 || !rows[0].posterImage) {
      return res.status(404).json({ message: 'Announcement poster not found' });
    }

    const announcement = rows[0];
    if (!req.user?.permissions?.includes('announcements:write')) {
      const isPublished = announcement.status === 'Published';
      const isExpired = announcement.expiresAt && new Date(announcement.expiresAt) < new Date();
      const audience = req.user?.role === 'resident' ? 'Residents' : req.user?.role === 'barangay_staff' ? 'Barangay Staff' : 'Admins';
      const audienceAllowed = announcement.audience === 'All' || announcement.audience === audience;
      const barangayAllowed = announcement.barangay
        ? normalizeBarangayName(announcement.barangay) === normalizeBarangayName(req.user?.barangay)
        : true;

      if (!isPublished || isExpired || !audienceAllowed || !barangayAllowed) {
        return res.status(403).json({ message: 'You do not have permission to view this announcement poster' });
      }
    }

    const posterPath = path.resolve(announcement.posterImage);
    if (!fs.existsSync(posterPath)) {
      return res.status(404).json({ message: 'Announcement poster file was not found on disk' });
    }

    return res.sendFile(posterPath);
  } catch (error) {
    return next(error);
  }
};

// Lists staff accounts with normalized permissions for the admin UI.
export const listStaff = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT sa.id, sa.name, sa.email, sa.barangay, sa.office_id AS officeId, o.name AS officeName, sa.role, sa.permissions, sa.status, sa.created_at AS createdAt
       FROM staff_accounts sa
       LEFT JOIN offices o ON o.id = sa.office_id
       ORDER BY sa.created_at DESC`
    );
    return res.json({
      data: rows.map((staff) => ({
        ...staff,
        permissions: normalizePermissions(staff.permissions, staff.role),
        permissionCount: normalizePermissions(staff.permissions, staff.role).length
      }))
    });
  } catch (error) {
    return next(error);
  }
};

// Creates a staff account (or upserts by email) with hashed password and permissions.
export const createStaff = async (req, res, next) => {
  try {
    const { name, email, barangay = null, officeId = null, role = 'barangay_staff', password = 'Staff@123', status = 'Active' } = req.body;
    const permissions = normalizePermissions(req.body.permissions, role);

    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required' });
    }

    const [result] = await pool.execute(
      `INSERT INTO staff_accounts (name, email, barangay, office_id, password_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), barangay = VALUES(barangay), office_id = VALUES(office_id), role = VALUES(role), permissions = VALUES(permissions), status = VALUES(status)`,
      [name, email, barangay, officeId, hashPassword(password), role, JSON.stringify(permissions), status]
    );

    await logAudit({ user: req.user, action: 'staff.create', entityType: 'staff_accounts', entityId: result.insertId, details: { name, email, role, permissions } });
    emitRealtimeEvent('staff:changed', { action: 'created', id: result.insertId });

    return res.status(201).json({ data: { id: result.insertId, name, email, barangay, officeId, role, permissions, status } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A staff account already exists for this email' });
    return next(error);
  }
};

// Updates staff profile, role, permissions, and optional password.
export const updateStaff = async (req, res, next) => {
  try {
    const { name, email, barangay = null, officeId = null, role = 'barangay_staff', password = '', status = 'Active' } = req.body;
    const permissions = normalizePermissions(req.body.permissions, role);

    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required' });
    }

    const [existingRows] = await pool.execute('SELECT id FROM staff_accounts WHERE id = ?', [req.params.id]);
    if (existingRows.length === 0) return res.status(404).json({ message: 'Staff account not found' });

    const values = [name, email, barangay, officeId || null, role, JSON.stringify(permissions), status];
    let passwordSql = '';

    if (password) {
      passwordSql = ', password_hash = ?';
      values.push(hashPassword(password));
    }

    values.push(req.params.id);

    await pool.execute(
      `UPDATE staff_accounts
       SET name = ?, email = ?, barangay = ?, office_id = ?, role = ?, permissions = ?, status = ?${passwordSql}
       WHERE id = ?`,
      values
    );

    await logAudit({
      user: req.user,
      action: 'staff.update',
      entityType: 'staff_accounts',
      entityId: req.params.id,
      details: { name, email, barangay, officeId, role, permissions, status, passwordChanged: Boolean(password) }
    });
    emitRealtimeEvent('staff:changed', { action: 'updated', id: req.params.id });
    emitRealtimeEvent('dashboard:changed', { reason: 'staff-updated' });

    return res.json({ data: { id: req.params.id, name, email, barangay, officeId, role, permissions, status } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'A staff account already exists for this email' });
    return next(error);
  }
};
