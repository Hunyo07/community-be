import { pool } from '../config/db.js';
import { emitRealtimeEvent } from '../realtime/socket.js';

export const logAudit = async ({ user, action, entityType, entityId = null, details = null }) => {
  try {
    await pool.execute(
      `INSERT INTO audit_logs (user_id, user_role, action, entity_type, entity_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        user?.id || null,
        user?.role || 'system',
        action,
        entityType,
        entityId,
        details ? JSON.stringify(details) : null
      ]
    );

    emitRealtimeEvent('audit:changed', { action, entityType, entityId });
  } catch (error) {
    console.error('Audit log failed:', error.message);
  }
};
