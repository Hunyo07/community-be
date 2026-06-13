import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { normalizePermissions, hasPermission } from '../rbac/roles.js';

export const authenticate = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = {
      ...payload,
      permissions: normalizePermissions(payload.permissions, payload.role)
    };
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You do not have access to this resource' });
  }

  return next();
};

export const authorizePermissions = (...permissions) => (req, res, next) => {
  const allowed = permissions.every((permission) => hasPermission(req.user, permission));

  if (!allowed) {
    return res.status(403).json({ message: 'You do not have permission to perform this action' });
  }

  return next();
};
