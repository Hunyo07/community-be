import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows, PASSWORD } from './helpers.js';

// These tests send real HTTP requests through the Express app to a real MySQL
// test database ("community_test"). Nothing is faked.
beforeAll(resetDatabase);
beforeEach(resetDatabase);
afterAll(closePool);

describe('health check', () => {
  it('reports that the API and the database are working', async () => {
    const res = await api().get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await api().get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.message).toBeTruthy();
  });
});

describe('login (BB-01 to BB-03)', () => {
  it.each([
    ['admin', accounts.admin.email, 'admin', 'staff'],
    ['barangay staff', accounts.staffBalanti.email, 'barangay_staff', 'staff'],
    ['resident', accounts.residentBalanti.email, 'resident', 'resident'],
  ])('signs in a %s and returns a token with the role', async (label, email, role, accountType) => {
    const res = await api().post('/api/auth/login', { email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ email, role, accountType });
    expect(res.body.data.user.permissions.length).toBeGreaterThan(0);
  });

  it('never sends the password or its hash back', async () => {
    const res = await api().post('/api/auth/login', {
      email: accounts.admin.email,
      password: PASSWORD,
    });

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain(PASSWORD);
  });

  it('writes a sign-in entry to the audit log', async () => {
    await api().post('/api/auth/login', { email: accounts.admin.email, password: PASSWORD });

    const rows = await dbRows("SELECT * FROM audit_logs WHERE action = 'auth.login_success'");
    expect(rows).toHaveLength(1);
  });

  it('rejects a wrong password with 401 and no token', async () => {
    const res = await api().post('/api/auth/login', {
      email: accounts.admin.email,
      password: 'WrongPass123',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
    expect(res.body.data).toBeUndefined();
  });

  it('gives an unknown email the same answer as a wrong password', async () => {
    const unknown = await api().post('/api/auth/login', {
      email: 'nobody@test.local',
      password: PASSWORD,
    });
    const wrong = await api().post('/api/auth/login', {
      email: accounts.admin.email,
      password: 'WrongPass123',
    });

    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('logs the failed attempt', async () => {
    await api().post('/api/auth/login', { email: accounts.admin.email, password: 'WrongPass123' });

    const rows = await dbRows("SELECT * FROM audit_logs WHERE action = 'auth.login_failed'");
    expect(rows).toHaveLength(1);
  });

  it.each([
    [{ email: accounts.admin.email }],
    [{ password: PASSWORD }],
    [{}],
  ])('rejects missing fields with 400 (%j)', async (body) => {
    const res = await api().post('/api/auth/login', body);

    expect(res.status).toBe(400);
  });

  it('blocks a resident who is not verified yet (403)', async () => {
    const res = await api().post('/api/auth/login', {
      email: accounts.residentPending.email,
      password: PASSWORD,
    });

    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('blocks a deactivated staff account (403)', async () => {
    await dbRows("UPDATE staff_accounts SET status = 'Inactive' WHERE email = ?", [accounts.staffBalanti.email]);

    const res = await api().post('/api/auth/login', {
      email: accounts.staffBalanti.email,
      password: PASSWORD,
    });

    expect(res.status).toBe(403);
  });
});

describe('using a token', () => {
  it('returns the signed-in user from /api/auth/me', async () => {
    const token = await loginAs(accounts.staffBalanti.email);

    const res = await api(token).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(accounts.staffBalanti.email);
  });

  it('rejects a request with no token (401)', async () => {
    const res = await api().get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a made-up token (401)', async () => {
    const res = await api('not.a.real.token').get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('stops working after sign-out (the token is revoked in the database)', async () => {
    const token = await loginAs(accounts.admin.email);
    expect((await api(token).get('/api/auth/me')).status).toBe(200);

    const logout = await api(token).post('/api/auth/logout', {});
    expect(logout.status).toBe(200);

    const after = await api(token).get('/api/auth/me');
    expect(after.status).toBe(401);
    expect(await dbRows('SELECT * FROM revoked_tokens')).toHaveLength(1);
  });

  it('does not end other sessions of the same person when one signs out', async () => {
    const first = await loginAs(accounts.admin.email);
    const second = await loginAs(accounts.admin.email);

    await api(first).post('/api/auth/logout', {});

    expect((await api(second).get('/api/auth/me')).status).toBe(200);
  });
});

describe('change password', () => {
  it('lets a user change their password, then the new one works and the old one does not', async () => {
    const token = await loginAs(accounts.residentBalanti.email);

    const res = await api(token).post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'NewPass456!',
    });
    expect(res.status).toBe(200);

    const oldLogin = await api().post('/api/auth/login', {
      email: accounts.residentBalanti.email,
      password: PASSWORD,
    });
    const newLogin = await api().post('/api/auth/login', {
      email: accounts.residentBalanti.email,
      password: 'NewPass456!',
    });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('rejects a wrong current password and keeps the old one', async () => {
    const token = await loginAs(accounts.residentBalanti.email);

    const res = await api(token).post('/api/auth/change-password', {
      currentPassword: 'WrongPass123',
      newPassword: 'NewPass456!',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Current password is incorrect');
    expect(await loginAs(accounts.residentBalanti.email)).toBeTruthy();
  });

  it.each(['Sh0rt!A', 'alllowercase1!', 'Has Space!1', 'NoSpecialChar1'])(
    'rejects the weak new password %s',
    async (newPassword) => {
      const token = await loginAs(accounts.residentBalanti.email);

      const res = await api(token).post('/api/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword,
      });

      expect(res.status).toBe(400);
      expect(await loginAs(accounts.residentBalanti.email)).toBeTruthy();
    },
  );

  it('requires a token', async () => {
    const res = await api().post('/api/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'NewPass456!',
    });
    expect(res.status).toBe(401);
  });
});
