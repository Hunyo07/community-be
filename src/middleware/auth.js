// Auth middleware: verifies JWT tokens and checks roles/permissions on protected routes.
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { normalizePermissions, hasPermission } from '../rbac/roles.js';

// True when the token was revoked by sign-out (manual or idle timeout).
const isTokenRevoked = async (jti) => {
  if (!jti) return false;
  const [rows] = await pool.execute('SELECT 1 FROM revoked_tokens WHERE jti = ? LIMIT 1', [jti]);
  return rows.length > 0;
};

// Require a valid, non-revoked Bearer token and attach the decoded user to req.user.
export const authenticate = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  if (await isTokenRevoked(payload.jti)) {
    return res.status(401).json({ message: 'Session has ended. Please sign in again.' });
  }

  req.user = {
    ...payload,
    permissions: normalizePermissions(payload.permissions, payload.role)
  };
  return next();
};

// Allow only users whose role is in the given list.
export const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You do not have access to this resource' });
  }

  return next();
};

// Allow only users who have every listed permission.
export const authorizePermissions = (...permissions) => (req, res, next) => {
  const allowed = permissions.every((permission) => hasPermission(req.user, permission));

  if (!allowed) {
    return res.status(403).json({ message: 'You do not have permission to perform this action' });
  }

  return next();
};
