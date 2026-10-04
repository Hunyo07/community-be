import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Replace the config and database with fakes before auth.js loads.
vi.mock('../src/config/env.js', () => ({
  env: { jwtSecret: 'test-secret' },
}));
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from '../src/config/db.js';
import { ROLES, PERMISSIONS, rolePermissions } from '../src/rbac/roles.js';
import {
  authenticate,
  authorizeRoles,
  authorizePermissions,
} from '../src/middleware/auth.js';

const SECRET = 'test-secret';

// Builds a fake Express response. status() returns res so calls can be chained.
const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

// Builds a fake request. Pass nothing to send no Authorization header.
const createReq = (authorization) => ({
  headers: authorization === undefined ? {} : { authorization },
});

// Creates a real signed token.
const signToken = (payload, secret = SECRET) => jwt.sign(payload, secret);

// Creates a ready-to-use "Bearer <token>" header value.
const bearer = (payload, secret = SECRET) =>
  `Bearer ${signToken(payload, secret)}`;

beforeEach(() => {
  pool.execute.mockReset();
  // By default no token is revoked.
  pool.execute.mockResolvedValue([[]]);
});

describe('authenticate: missing or malformed header', () => {
  it('returns 401 when there is no Authorization header', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(createReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the scheme is not Bearer', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(createReq('Basic abc123'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when "Bearer " has no token after it', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(createReq('Bearer '), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('is case sensitive about the word Bearer', async () => {
    const res = createRes();
    const next = vi.fn();
    const token = signToken({ id: 1, role: 'admin' });
    await authenticate(createReq(`bearer ${token}`), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authenticate: invalid tokens', () => {
  it('returns 401 for a token that is not a real JWT', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(createReq('Bearer garbage'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a token signed with a different secret', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(
      createReq(bearer({ id: 1, role: 'admin' }, 'someone-elses-secret')),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', async () => {
    const res = createRes();
    const next = vi.fn();
    const expired = {
      id: 1,
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) - 60,
    };
    await authenticate(createReq(bearer(expired)), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not query the database for an invalid token', async () => {
    await authenticate(createReq('Bearer garbage'), createRes(), vi.fn());
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('authenticate: valid tokens', () => {
  it('calls next and sends no response', async () => {
    const res = createRes();
    const next = vi.fn();
    await authenticate(createReq(bearer({ id: 5, role: 'admin' })), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('attaches the token contents to req.user', async () => {
    const req = createReq(
      bearer({ id: 5, role: 'admin', email: 'ana@example.com' }),
    );
    await authenticate(req, createRes(), vi.fn());

    expect(req.user).toMatchObject({
      id: 5,
      role: 'admin',
      email: 'ana@example.com',
    });
  });

  it('skips the revocation lookup when the token has no jti', async () => {
    await authenticate(
      createReq(bearer({ id: 5, role: 'admin' })),
      createRes(),
      vi.fn(),
    );
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('checks revocation with a safe parameterized query when there is a jti', async () => {
    await authenticate(
      createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' })),
      createRes(),
      vi.fn(),
    );

    expect(pool.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('revoked_tokens');
    expect(sql).toContain('?');
    expect(sql).not.toContain('abc-123');
    expect(params).toEqual(['abc-123']);
  });

  it('lets a token through when its jti is not revoked', async () => {
    const next = vi.fn();
    await authenticate(
      createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' })),
      createRes(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('gives residents only their default permissions, even if the token claims more', async () => {
    const req = createReq(
      bearer({
        id: 1,
        role: ROLES.RESIDENT,
        permissions: [PERMISSIONS.SETTINGS_MANAGE],
      }),
    );
    await authenticate(req, createRes(), vi.fn());

    expect(req.user.permissions).toEqual(rolePermissions[ROLES.RESIDENT]);
    expect(req.user.permissions).not.toContain(PERMISSIONS.SETTINGS_MANAGE);
  });

  it('removes unknown permission codes from the token', async () => {
    const req = createReq(
      bearer({
        id: 1,
        role: ROLES.ADMIN,
        permissions: [PERMISSIONS.PROFILE_READ, 'fake:perm'],
      }),
    );
    await authenticate(req, createRes(), vi.fn());

    expect(req.user.permissions).toEqual([PERMISSIONS.PROFILE_READ]);
  });

  it('falls back to the role defaults when the token has no permissions', async () => {
    const req = createReq(bearer({ id: 2, role: ROLES.BARANGAY_STAFF }));
    await authenticate(req, createRes(), vi.fn());

    expect(req.user.permissions).toEqual(rolePermissions[ROLES.BARANGAY_STAFF]);
  });
});

describe('authenticate: revoked tokens', () => {
  beforeEach(() => {
    pool.execute.mockResolvedValue([[{ revoked: 1 }]]);
  });

  it('returns 401 with a "session ended" message', async () => {
    const res = createRes();
    await authenticate(
      createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' })),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Session has ended. Please sign in again.',
    });
  });

  it('does not call next', async () => {
    const next = vi.fn();
    await authenticate(
      createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' })),
      createRes(),
      next,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('does not attach a user to the request', async () => {
    const req = createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' }));
    await authenticate(req, createRes(), vi.fn());
    expect(req.user).toBeUndefined();
  });
});

describe('authenticate: database failure', () => {
  it('fails closed: rejects and never calls next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));
    const res = createRes();
    const next = vi.fn();

    await expect(
      authenticate(
        createReq(bearer({ id: 5, role: 'admin', jti: 'abc-123' })),
        res,
        next,
      ),
    ).rejects.toThrow('Database is down');

    expect(next).not.toHaveBeenCalled();
  });
});

describe('authorizeRoles', () => {
  it('allows a user whose role is listed', () => {
    const next = vi.fn();
    const res = createRes();
    authorizeRoles(ROLES.ADMIN)({ user: { role: ROLES.ADMIN } }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows any one of several listed roles', () => {
    const middleware = authorizeRoles(ROLES.ADMIN, ROLES.BARANGAY_STAFF);
    const next = vi.fn();
    middleware({ user: { role: ROLES.BARANGAY_STAFF } }, createRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for a role that is not listed', () => {
    const res = createRes();
    const next = vi.fn();
    authorizeRoles(ROLES.ADMIN)({ user: { role: ROLES.RESIDENT } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You do not have access to this resource',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when there is no user on the request', () => {
    const res = createRes();
    const next = vi.fn();
    authorizeRoles(ROLES.ADMIN)({}, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks everyone when no roles are listed', () => {
    const res = createRes();
    const next = vi.fn();
    authorizeRoles()({ user: { role: ROLES.ADMIN } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('authorizePermissions', () => {
  const staffWithReports = {
    role: ROLES.BARANGAY_STAFF,
    permissions: [PERMISSIONS.REPORTS_READ, PERMISSIONS.DASHBOARD_READ],
  };

  it('allows a user who has the permission', () => {
    const next = vi.fn();
    const res = createRes();
    authorizePermissions(PERMISSIONS.REPORTS_READ)(
      { user: staffWithReports },
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows a user who has every listed permission', () => {
    const next = vi.fn();
    authorizePermissions(PERMISSIONS.REPORTS_READ, PERMISSIONS.DASHBOARD_READ)(
      { user: staffWithReports },
      createRes(),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when even one listed permission is missing', () => {
    const res = createRes();
    const next = vi.fn();
    authorizePermissions(PERMISSIONS.REPORTS_READ, PERMISSIONS.SETTINGS_MANAGE)(
      { user: staffWithReports },
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You do not have permission to perform this action',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when there is no user on the request', () => {
    const res = createRes();
    const next = vi.fn();
    authorizePermissions(PERMISSIONS.PROFILE_READ)({}, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not let a resident gain permissions by listing them', () => {
    const res = createRes();
    const next = vi.fn();
    authorizePermissions(PERMISSIONS.SETTINGS_MANAGE)(
      {
        user: {
          role: ROLES.RESIDENT,
          permissions: [PERMISSIONS.SETTINGS_MANAGE],
        },
      },
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('reads permissions stored as a JSON string', () => {
    const next = vi.fn();
    authorizePermissions(PERMISSIONS.REPORTS_READ)(
      { user: { role: ROLES.ADMIN, permissions: '["reports:read"]' } },
      createRes(),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});