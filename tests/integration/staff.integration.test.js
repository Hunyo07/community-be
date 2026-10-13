import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows, pool, PASSWORD } from './helpers.js';
import { hashPassword } from '../../src/utils/password.js';

let admin;
let barangayAdmin;

const NEW_PASSWORD = 'StaffPass1!';
const newStaff = (extra = {}) => ({
  name: 'Nina Staff',
  email: 'nina.staff@test.local',
  barangay: 'Balanti',
  role: 'barangay_staff',
  password: NEW_PASSWORD,
  ...extra,
});

beforeEach(async () => {
  await resetDatabase();
  // An admin who belongs to one barangay (not city-wide).
  await pool.execute(
    `INSERT INTO staff_accounts (name, email, barangay, password_hash, role, permissions, status)
     VALUES ('Barangay Admin', 'badmin@test.local', 'Balanti', ?, 'admin', NULL, 'Active')`,
    [hashPassword(PASSWORD)],
  );
  admin = await loginAs(accounts.admin.email);
  barangayAdmin = await loginAs('badmin@test.local');
});
afterAll(closePool);

describe('creating staff accounts (FR15)', () => {
  it('saves a hashed password and the new staff member can sign in', async () => {
    const res = await api(admin).post('/api/staff', newStaff());

    expect(res.status).toBe(201);
    const [row] = await dbRows('SELECT * FROM staff_accounts WHERE email = ?', ['nina.staff@test.local']);
    expect(row.password_hash).not.toBe(NEW_PASSWORD);
    expect(row.password_hash).not.toContain(NEW_PASSWORD);
    expect(row.barangay).toBe('Balanti');

    const login = await api().post('/api/auth/login', {
      email: 'nina.staff@test.local',
      password: NEW_PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('barangay_staff');
  });

  it('appears in the staff list without any password data', async () => {
    await api(admin).post('/api/staff', newStaff());

    const res = await api(admin).get('/api/staff');

    expect(JSON.stringify(res.body.data)).toContain('nina.staff@test.local');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('writes an audit log entry that does not contain the password', async () => {
    await api(admin).post('/api/staff', newStaff());

    const rows = await dbRows("SELECT * FROM audit_logs WHERE action = 'staff.create'");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(NEW_PASSWORD);
  });

  it('keeps only valid permissions', async () => {
    await api(admin).post('/api/staff', newStaff({ permissions: ['reports:read', 'fake:perm'] }));

    const [row] = await dbRows('SELECT permissions FROM staff_accounts WHERE email = ?', ['nina.staff@test.local']);
    const saved = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions;
    expect(saved).toEqual(['reports:read']);
  });

  it.each([
    ['a weak password', { password: 'weakpass' }],
    ['a name with numbers', { name: 'Nina 123' }],
    ['a missing name', { name: '' }],
    ['a bad email', { email: 'not-an-email' }],
    ['a missing email', { email: '' }],
    ['a barangay that does not exist', { barangay: 'Atlantis' }],
  ])('rejects %s with 400 and saves nothing', async (label, extra) => {
    const res = await api(admin).post('/api/staff', newStaff(extra));

    expect(res.status).toBe(400);
    expect(await dbRows('SELECT id FROM staff_accounts WHERE email = ?', ['nina.staff@test.local'])).toHaveLength(0);
  });

  it('forces a barangay admin to create staff in their own barangay', async () => {
    const res = await api(barangayAdmin).post('/api/staff', newStaff({ barangay: 'Aguso' }));

    expect(res.status).toBe(201);
    const [row] = await dbRows('SELECT barangay FROM staff_accounts WHERE email = ?', ['nina.staff@test.local']);
    expect(row.barangay).toBe('Balanti');
  });

  it('stops a barangay admin from taking over an account in another barangay (409)', async () => {
    const res = await api(barangayAdmin).post(
      '/api/staff',
      newStaff({ email: accounts.staffAguso.email }),
    );

    expect(res.status).toBe(409);
    const [row] = await dbRows('SELECT name, barangay FROM staff_accounts WHERE email = ?', [accounts.staffAguso.email]);
    expect(row).toMatchObject({ name: 'Staff Aguso', barangay: 'Aguso' });
  });
});

describe('listing staff by barangay', () => {
  it('shows a city-wide admin the staff of every barangay', async () => {
    const res = await api(admin).get('/api/staff');
    const emails = res.body.data.map((s) => s.email);

    expect(emails).toEqual(
      expect.arrayContaining([accounts.staffBalanti.email, accounts.staffAguso.email, 'badmin@test.local']),
    );
  });

  it('shows a barangay admin only the staff of their own barangay', async () => {
    const res = await api(barangayAdmin).get('/api/staff');
    const emails = res.body.data.map((s) => s.email);

    expect(emails).toContain(accounts.staffBalanti.email);
    expect(emails).not.toContain(accounts.staffAguso.email);
  });
});

describe('updating and deactivating staff (FR15, FR16)', () => {
  const idOf = async (email) =>
    (await dbRows('SELECT id FROM staff_accounts WHERE email = ?', [email]))[0].id;

  const body = (email, extra = {}) => ({
    name: 'Renamed Staff',
    email,
    barangay: 'Balanti',
    role: 'barangay_staff',
    status: 'Active',
    ...extra,
  });

  it('updates the name', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    const res = await api(admin).patch(`/api/staff/${id}`, body(accounts.staffBalanti.email));

    expect(res.status).toBe(200);
    const [row] = await dbRows('SELECT name FROM staff_accounts WHERE id = ?', [id]);
    expect(row.name).toBe('Renamed Staff');
  });

  it('deactivates an account so the person can no longer sign in', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    const res = await api(admin).patch(
      `/api/staff/${id}`,
      body(accounts.staffBalanti.email, { status: 'Inactive' }),
    );

    expect(res.status).toBe(200);
    const login = await api().post('/api/auth/login', {
      email: accounts.staffBalanti.email,
      password: PASSWORD,
    });
    expect(login.status).toBe(403);
  });

  it('reactivates an account so the person can sign in again', async () => {
    const id = await idOf(accounts.staffBalanti.email);
    await api(admin).patch(`/api/staff/${id}`, body(accounts.staffBalanti.email, { status: 'Inactive' }));

    await api(admin).patch(`/api/staff/${id}`, body(accounts.staffBalanti.email, { status: 'Active' }));

    const login = await api().post('/api/auth/login', {
      email: accounts.staffBalanti.email,
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
  });

  it('sets a new password: the new one works and the old one does not', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    await api(admin).patch(
      `/api/staff/${id}`,
      body(accounts.staffBalanti.email, { password: NEW_PASSWORD }),
    );

    const oldLogin = await api().post('/api/auth/login', {
      email: accounts.staffBalanti.email,
      password: PASSWORD,
    });
    const newLogin = await api().post('/api/auth/login', {
      email: accounts.staffBalanti.email,
      password: NEW_PASSWORD,
    });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('keeps the old password when none is sent', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    await api(admin).patch(`/api/staff/${id}`, body(accounts.staffBalanti.email));

    expect(await loginAs(accounts.staffBalanti.email)).toBeTruthy();
  });

  it('rejects a weak new password and changes nothing', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    const res = await api(admin).patch(
      `/api/staff/${id}`,
      body(accounts.staffBalanti.email, { password: 'weak' }),
    );

    expect(res.status).toBe(400);
    const [row] = await dbRows('SELECT name FROM staff_accounts WHERE id = ?', [id]);
    expect(row.name).toBe('Staff Balanti');
  });

  it('returns 404 for an account that does not exist', async () => {
    const res = await api(admin).patch('/api/staff/99999', body('x@test.local'));
    expect(res.status).toBe(404);
  });

  it('stops a barangay admin from editing staff of another barangay (403)', async () => {
    const id = await idOf(accounts.staffAguso.email);

    const res = await api(barangayAdmin).patch(
      `/api/staff/${id}`,
      body(accounts.staffAguso.email, { password: NEW_PASSWORD }),
    );

    expect(res.status).toBe(403);
    const [row] = await dbRows('SELECT name FROM staff_accounts WHERE id = ?', [id]);
    expect(row.name).toBe('Staff Aguso');
    expect(
      (await api().post('/api/auth/login', { email: accounts.staffAguso.email, password: PASSWORD })).status,
    ).toBe(200);
  });

  it('writes an audit log entry for the update', async () => {
    const id = await idOf(accounts.staffBalanti.email);

    await api(admin).patch(`/api/staff/${id}`, body(accounts.staffBalanti.email));

    expect(await dbRows("SELECT id FROM audit_logs WHERE action = 'staff.update'")).toHaveLength(1);
  });
});
