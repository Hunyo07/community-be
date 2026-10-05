import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Replace everything the controller talks to with fakes before it loads.
vi.mock('../src/config/env.js', () => ({
  env: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '1h',
    mail: { otpExpiresMinutes: 10 },
  },
}));
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn(), query: vi.fn() },
}));
vi.mock('../src/config/mailer.js', () => ({
  assertMailerConfigured: vi.fn(),
  sendOtpEmail: vi.fn(),
  sendPasswordResetOtpEmail: vi.fn(),
}));
vi.mock('../src/realtime/socket.js', () => ({
  emitRealtimeEvent: vi.fn(),
}));
vi.mock('../src/utils/auditLogger.js', () => ({
  logAudit: vi.fn(),
}));
vi.mock('../src/utils/password.js', () => ({
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock('../src/utils/settings.js', () => ({
  isSettingEnabled: vi.fn(),
}));
vi.mock('../src/utils/residentName.js', () => ({
  formatResidentName: (first, middle, last) =>
    [first, middle, last].filter(Boolean).join(' '),
  normalizeMiddleName: (value) => value || null,
}));

import { pool } from '../src/config/db.js';
import { logAudit } from '../src/utils/auditLogger.js';
import { hashPassword, verifyPassword } from '../src/utils/password.js';
import { PASSWORD_POLICY_MESSAGE } from '../src/utils/passwordPolicy.js';
import { ROLES, rolePermissions } from '../src/rbac/roles.js';
import {
  login,
  getCurrentUser,
  logout,
  changePassword,
} from '../src/controllers/authController.js';

// Builds a fake Express response. status() returns res so calls can be chained.
const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

// A staff account row as the database would return it.
const staffRow = (overrides = {}) => ({
  id: 1,
  name: 'Ana Admin',
  email: 'ana@example.com',
  barangay: 'Balanti',
  office_id: 3,
  password_hash: 'stored-hash',
  role: 'admin',
  permissions: null,
  status: 'Active',
  ...overrides,
});

// A resident account row as the database would return it.
const residentRow = (overrides = {}) => ({
  id: 9,
  first_name: 'Juan',
  middle_name: 'Dela',
  last_name: 'Cruz',
  email: 'juan@example.com',
  barangay: 'Balanti',
  password_hash: 'stored-hash',
  role: 'resident',
  verification_status: 'Verified',
  account_status: 'Active',
  status: 'Active',
  ...overrides,
});

// Fake database answers: the staff lookup first, then the resident lookup (only if no staff).
const mockLookups = ({ staff = null, resident = null } = {}) => {
  pool.execute.mockResolvedValueOnce([staff ? [staff] : []]);
  if (!staff) {
    pool.execute.mockResolvedValueOnce([resident ? [resident] : []]);
  }
};

const CREDENTIALS = { email: 'ana@example.com', password: 'Password1' };

const callLogin = async (body) => {
  const res = createRes();
  const next = vi.fn();
  await login({ body }, res, next);
  return { res, next };
};

beforeEach(() => {
  pool.execute.mockReset();
  logAudit.mockReset();
  verifyPassword.mockReset();
  hashPassword.mockReset();
});

describe('login: missing fields', () => {
  it('passes a 400 error to next when email and password are both missing', async () => {
    const { res, next } = await callLogin({});

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Missing required fields: email, password');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('names only the password when the password is missing', async () => {
    const { next } = await callLogin({ email: 'ana@example.com' });
    expect(next.mock.calls[0][0].message).toBe('Missing required fields: password');
  });

  it('names only the email when the email is missing', async () => {
    const { next } = await callLogin({ password: 'Password1' });
    expect(next.mock.calls[0][0].message).toBe('Missing required fields: email');
  });

  it('treats empty strings as missing', async () => {
    const { next } = await callLogin({ email: '', password: '' });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('does not query the database when fields are missing', async () => {
    await callLogin({});
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('login: staff success', () => {
  it('responds with a token and user, with no error', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    const { res, next } = await callLogin(CREDENTIALS);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].data.token).toEqual(expect.any(String));
  });

  it('checks the typed password against the stored hash', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    await callLogin(CREDENTIALS);

    expect(verifyPassword).toHaveBeenCalledWith('Password1', 'stored-hash');
  });

  it('puts the identity and role inside the token', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);
    const { token } = res.json.mock.calls[0][0].data;
    const payload = jwt.verify(token, 'test-secret');

    expect(payload).toMatchObject({
      id: 1,
      email: 'ana@example.com',
      name: 'Ana Admin',
      role: 'admin',
      barangay: 'Balanti',
      officeId: 3,
      accountType: 'staff',
    });
  });

  it('gives the token an expiry and a unique id each time', async () => {
    mockLookups({ staff: staffRow() });
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    const first = await callLogin(CREDENTIALS);
    const second = await callLogin(CREDENTIALS);

    const a = jwt.verify(first.res.json.mock.calls[0][0].data.token, 'test-secret');
    const b = jwt.verify(second.res.json.mock.calls[0][0].data.token, 'test-secret');

    expect(a.exp).toBeGreaterThan(a.iat);
    expect(a.jti).toEqual(expect.any(String));
    expect(a.jti).not.toBe(b.jti);
  });

  it('returns user details without the password hash', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);
    const { user } = res.json.mock.calls[0][0].data;

    expect(user).toMatchObject({
      id: 1,
      name: 'Ana Admin',
      email: 'ana@example.com',
      role: 'admin',
      barangay: 'Balanti',
      accountType: 'staff',
    });
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('stored-hash');
  });

  it('includes the office id for staff', async () => {
    mockLookups({ staff: staffRow({ office_id: 7 }) });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);
    expect(res.json.mock.calls[0][0].data.user.officeId).toBe(7);
  });

  it('reads staff permissions saved as a JSON string', async () => {
    mockLookups({
      staff: staffRow({
        role: ROLES.BARANGAY_STAFF,
        permissions: '["reports:read"]',
      }),
    });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);
    expect(res.json.mock.calls[0][0].data.user.permissions).toEqual(['reports:read']);
  });

  it('records a login_success audit entry', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    await callLogin(CREDENTIALS);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_success',
        entityType: 'staff_accounts',
        entityId: 1,
      }),
    );
  });

  it('looks up the staff account with the email as a parameter', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    await callLogin(CREDENTIALS);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('staff_accounts');
    expect(sql).not.toContain('ana@example.com');
    expect(params).toEqual(['ana@example.com']);
  });

  it('uses the staff account and skips the resident lookup when both could match', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(true);

    await callLogin(CREDENTIALS);

    expect(pool.execute).toHaveBeenCalledTimes(1);
  });
});

describe('login: resident success', () => {
  const residentCredentials = { email: 'juan@example.com', password: 'Password1' };

  it('logs in a verified and active resident', async () => {
    mockLookups({ resident: residentRow() });
    verifyPassword.mockReturnValue(true);

    const { res, next } = await callLogin(residentCredentials);
    const { user } = res.json.mock.calls[0][0].data;

    expect(next).not.toHaveBeenCalled();
    expect(user).toMatchObject({
      id: 9,
      name: 'Juan Dela Cruz',
      email: 'juan@example.com',
      role: 'resident',
      accountType: 'resident',
      verificationStatus: 'Verified',
      accountStatus: 'Active',
    });
  });

  it('gives residents only their default permissions', async () => {
    mockLookups({ resident: residentRow() });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(residentCredentials);

    expect(res.json.mock.calls[0][0].data.user.permissions).toEqual(
      rolePermissions[ROLES.RESIDENT],
    );
  });

  it('checks the staff table first, then the resident table', async () => {
    mockLookups({ resident: residentRow() });
    verifyPassword.mockReturnValue(true);

    await callLogin(residentCredentials);

    expect(pool.execute).toHaveBeenCalledTimes(2);
    expect(pool.execute.mock.calls[0][0]).toContain('staff_accounts');
    expect(pool.execute.mock.calls[1][0]).toContain('resident_accounts');
  });
});

describe('login: wrong credentials', () => {
  const wrong = { email: 'nobody@example.com', password: 'Whatever1' };

  it('returns 401 for an unknown email', async () => {
    mockLookups({});

    const { res, next } = await callLogin(wrong);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid email or password' });
    expect(next).not.toHaveBeenCalled();
  });

  it('records a login_failed audit entry for an unknown email', async () => {
    mockLookups({});

    await callLogin(wrong);

    expect(logAudit).toHaveBeenCalledWith({
      user: null,
      action: 'auth.login_failed',
      entityType: 'auth',
      details: { email: 'nobody@example.com', reason: 'invalid_credentials' },
    });
  });

  it('does not check any password when the email is unknown', async () => {
    mockLookups({});
    await callLogin(wrong);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong password', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);

    const { res } = await callLogin(CREDENTIALS);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid email or password' });
  });

  it('does not issue a token for a wrong password', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);

    const { res } = await callLogin(CREDENTIALS);

    expect(res.json.mock.calls[0][0]).not.toHaveProperty('data');
  });

  it('records a login_failed audit entry for a wrong password', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);

    await callLogin(CREDENTIALS);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_failed',
        details: { email: 'ana@example.com', reason: 'invalid_credentials' },
      }),
    );
  });

  it('gives the same response for an unknown email and a wrong password', async () => {
    mockLookups({});
    const unknown = await callLogin(wrong);

    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);
    const badPassword = await callLogin(CREDENTIALS);

    expect(unknown.res.status.mock.calls[0]).toEqual(badPassword.res.status.mock.calls[0]);
    expect(unknown.res.json.mock.calls[0][0]).toEqual(badPassword.res.json.mock.calls[0][0]);
  });

  it('does not reveal a deactivated account to someone with the wrong password', async () => {
    mockLookups({ staff: staffRow({ status: 'Inactive' }) });
    verifyPassword.mockReturnValue(false);

    const { res } = await callLogin(CREDENTIALS);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid email or password' });
  });
});

describe('login: blocked accounts', () => {
  const blockedMessage = { message: 'Your account is not verified and active yet' };

  it('returns 403 for a deactivated staff account', async () => {
    mockLookups({ staff: staffRow({ status: 'Inactive' }) });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(blockedMessage);
  });

  it('records a login_blocked audit entry for deactivated staff', async () => {
    mockLookups({ staff: staffRow({ status: 'Inactive' }) });
    verifyPassword.mockReturnValue(true);

    await callLogin(CREDENTIALS);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_blocked',
        entityType: 'staff_accounts',
        entityId: 1,
      }),
    );
  });

  it('does not issue a token to a deactivated staff account', async () => {
    mockLookups({ staff: staffRow({ status: 'Inactive' }) });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin(CREDENTIALS);

    expect(res.json.mock.calls[0][0]).not.toHaveProperty('data');
  });

  it('returns 403 for a resident who is still pending verification', async () => {
    mockLookups({
      resident: residentRow({
        verification_status: 'Pending',
        account_status: 'Inactive',
        status: 'Pending',
      }),
    });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin({ email: 'juan@example.com', password: 'Password1' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(blockedMessage);
  });

  it('returns 403 for a verified resident whose account is inactive', async () => {
    mockLookups({
      resident: residentRow({ verification_status: 'Verified', account_status: 'Inactive' }),
    });
    verifyPassword.mockReturnValue(true);

    const { res } = await callLogin({ email: 'juan@example.com', password: 'Password1' });

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('records a login_blocked audit entry for a pending resident', async () => {
    mockLookups({
      resident: residentRow({
        verification_status: 'Pending',
        account_status: 'Inactive',
        status: 'Pending',
      }),
    });
    verifyPassword.mockReturnValue(true);

    await callLogin({ email: 'juan@example.com', password: 'Password1' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_blocked',
        entityType: 'resident_accounts',
        entityId: 9,
      }),
    );
  });
});

describe('login: database failure', () => {
  it('passes the error to next and sends no response', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await callLogin(CREDENTIALS);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('getCurrentUser', () => {
  const user = {
    id: 1,
    name: 'Ana Admin',
    email: 'ana@example.com',
    role: 'admin',
    barangay: 'Balanti',
    officeId: 3,
    accountType: 'staff',
    permissions: ['profile:read'],
    jti: 'secret-token-id',
    iat: 100,
    exp: 200,
  };

  it('returns the signed-in user details', () => {
    const res = createRes();
    getCurrentUser({ user }, res);

    expect(res.json).toHaveBeenCalledWith({
      data: {
        user: {
          id: 1,
          name: 'Ana Admin',
          email: 'ana@example.com',
          role: 'admin',
          barangay: 'Balanti',
          officeId: 3,
          accountType: 'staff',
          permissions: ['profile:read'],
        },
      },
    });
  });

  it('does not leak token internals', () => {
    const res = createRes();
    getCurrentUser({ user }, res);

    const returned = res.json.mock.calls[0][0].data.user;
    expect(returned).not.toHaveProperty('jti');
    expect(returned).not.toHaveProperty('iat');
    expect(returned).not.toHaveProperty('exp');
  });
});

describe('logout', () => {
  const staffUser = {
    id: 1,
    email: 'ana@example.com',
    accountType: 'staff',
    jti: 'jti-1',
    exp: 1900000000,
  };

  const callLogout = async (user, body) => {
    const res = createRes();
    const next = vi.fn();
    await logout({ user, body }, res, next);
    return { res, next };
  };

  it('signs the user out', async () => {
    const { res, next } = await callLogout(staffUser, { reason: 'manual' });

    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
    expect(next).not.toHaveBeenCalled();
  });

  it('removes expired revoked tokens, then revokes the current token', async () => {
    await callLogout(staffUser, { reason: 'manual' });

    expect(pool.execute).toHaveBeenCalledTimes(2);
    expect(pool.execute.mock.calls[0][0]).toContain('DELETE FROM revoked_tokens');
    expect(pool.execute.mock.calls[1][0]).toContain('INSERT INTO revoked_tokens');
  });

  it('revokes the token with safe parameters', async () => {
    await callLogout(staffUser, { reason: 'manual' });

    const [sql, params] = pool.execute.mock.calls[1];
    expect(sql).not.toContain('jti-1');
    expect(params).toEqual(['jti-1', 1900000000]);
  });

  it('records a logout audit entry', async () => {
    await callLogout(staffUser, { reason: 'manual' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout',
        entityType: 'staff_accounts',
        entityId: 1,
        details: { email: 'ana@example.com', reason: 'manual' },
      }),
    );
  });

  it('records an idle timeout logout with its own action', async () => {
    await callLogout(staffUser, { reason: 'idle_timeout' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout_idle_timeout',
        details: { email: 'ana@example.com', reason: 'idle_timeout' },
      }),
    );
  });

  it('treats an unknown reason as a manual logout', async () => {
    await callLogout(staffUser, { reason: 'hacked' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout',
        details: { email: 'ana@example.com', reason: 'manual' },
      }),
    );
  });

  it('treats a missing body as a manual logout', async () => {
    const { res } = await callLogout(staffUser, undefined);

    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout' }),
    );
  });

  it('still signs out without database writes when the token has no jti', async () => {
    const { res } = await callLogout(
      { id: 1, email: 'ana@example.com', accountType: 'staff' },
      { reason: 'manual' },
    );

    expect(pool.execute).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: 'Signed out successfully' });
  });

  it('logs a resident logout against the resident table', async () => {
    await callLogout({ ...staffUser, accountType: 'resident' }, { reason: 'manual' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'resident_accounts' }),
    );
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await callLogout(staffUser, { reason: 'manual' });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('changePassword', () => {
  const staffUser = { id: 1, email: 'ana@example.com' };
  const goodBody = { currentPassword: 'OldPass123', newPassword: 'NewPass123' };

  const callChange = async (user, body) => {
    const res = createRes();
    const next = vi.fn();
    await changePassword({ user, body }, res, next);
    return { res, next };
  };

  it('passes a 400 error to next when fields are missing', async () => {
    const { next } = await callChange(staffUser, {});

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'Missing required fields: currentPassword, newPassword',
    );
  });

  it('rejects a new password that breaks the policy', async () => {
    for (const newPassword of ['short', 'password1', 'Password1!']) {
      const { res } = await callChange(staffUser, {
        currentPassword: 'OldPass123',
        newPassword,
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: PASSWORD_POLICY_MESSAGE });
    }
  });

  it('does not touch the database for a new password that breaks the policy', async () => {
    await callChange(staffUser, { currentPassword: 'OldPass123', newPassword: 'short' });
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns 400 when the current password is wrong', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);

    const { res } = await callChange(staffUser, goodBody);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Current password is incorrect' });
  });

  it('does not update anything when the current password is wrong', async () => {
    mockLookups({ staff: staffRow() });
    verifyPassword.mockReturnValue(false);

    await callChange(staffUser, goodBody);

    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('returns the same error when the account cannot be found', async () => {
    mockLookups({});

    const { res } = await callChange(staffUser, goodBody);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Current password is incorrect' });
  });

  it('checks the current password against the stored hash', async () => {
    mockLookups({ staff: staffRow() });
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    verifyPassword.mockReturnValue(true);
    hashPassword.mockReturnValue('new-hash');

    await callChange(staffUser, goodBody);

    expect(verifyPassword).toHaveBeenCalledWith('OldPass123', 'stored-hash');
  });

  it('saves the hash of the new password, not the old one', async () => {
    mockLookups({ staff: staffRow() });
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    verifyPassword.mockReturnValue(true);
    hashPassword.mockReturnValue('new-hash');

    await callChange(staffUser, goodBody);

    expect(hashPassword).toHaveBeenCalledWith('NewPass123');
    const [sql, params] = pool.execute.mock.calls[1];
    expect(sql).toContain('UPDATE staff_accounts');
    expect(params).toEqual(['new-hash', 1]);
  });

  it('responds with a success message and records an audit entry', async () => {
    mockLookups({ staff: staffRow() });
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    verifyPassword.mockReturnValue(true);
    hashPassword.mockReturnValue('new-hash');

    const { res, next } = await callChange(staffUser, goodBody);

    expect(res.json).toHaveBeenCalledWith({ message: 'Password changed successfully' });
    expect(next).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.password_changed',
        entityType: 'staff_accounts',
        entityId: 1,
      }),
    );
  });

  it('updates the resident table for a resident account', async () => {
    mockLookups({ resident: residentRow() });
    pool.execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    verifyPassword.mockReturnValue(true);
    hashPassword.mockReturnValue('new-hash');

    await callChange({ id: 9, email: 'juan@example.com' }, goodBody);

    const [sql, params] = pool.execute.mock.calls[2];
    expect(sql).toContain('UPDATE resident_accounts');
    expect(params).toEqual(['new-hash', 9]);
  });
});