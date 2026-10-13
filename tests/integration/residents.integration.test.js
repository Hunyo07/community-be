import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows, PASSWORD } from './helpers.js';

let admin;
let staffBalanti;
let staffAguso;
let residentBalanti;

const newResident = (extra = {}) => ({
  firstName: 'Lita',
  lastName: 'Garcia',
  email: 'lita.garcia@test.local',
  barangay: 'Balanti',
  birthDate: '1995-05-20',
  gender: 'Female',
  password: 'ResidentPass1!',
  ...extra,
});

beforeEach(async () => {
  await resetDatabase();
  admin = await loginAs(accounts.admin.email);
  staffBalanti = await loginAs(accounts.staffBalanti.email);
  staffAguso = await loginAs(accounts.staffAguso.email);
  residentBalanti = await loginAs(accounts.residentBalanti.email);
});
afterAll(closePool);

const emailsOf = (res) => res.body.data.map((r) => r.email);

describe('adding a resident (BB-04 to BB-06)', () => {
  it('saves the resident, calculates the age and hashes the password', async () => {
    const res = await api(admin).post('/api/residents', newResident());

    expect(res.status).toBe(201);
    const [row] = await dbRows('SELECT * FROM resident_accounts WHERE email = ?', ['lita.garcia@test.local']);
    expect(row.first_name).toBe('Lita');
    expect(row.age).toBeGreaterThanOrEqual(30);
    expect(row.password_hash).not.toContain('ResidentPass1!');
    expect(row.verification_status).toBe('Pending');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('shows the new resident in the resident list', async () => {
    await api(admin).post('/api/residents', newResident());

    const list = await api(admin).get('/api/residents');

    expect(emailsOf(list)).toContain('lita.garcia@test.local');
  });

  it('writes an audit log entry', async () => {
    await api(admin).post('/api/residents', newResident());

    expect(await dbRows("SELECT id FROM audit_logs WHERE action = 'residents.create'")).toHaveLength(1);
  });

  it.each([
    ['first name', { firstName: '' }],
    ['last name', { lastName: '' }],
    ['email', { email: '' }],
    ['barangay', { barangay: '' }],
    ['birthdate', { birthDate: '' }],
  ])('rejects a missing %s with 400 and saves nothing', async (label, extra) => {
    const res = await api(admin).post('/api/residents', newResident(extra));

    expect(res.status).toBe(400);
    expect(await dbRows("SELECT id FROM resident_accounts WHERE last_name = 'Garcia'")).toHaveLength(0);
  });

  it.each([
    ['an unknown gender', { gender: 'Robot' }],
    ['an unknown civil status', { civilStatus: 'Complicated' }],
    ['a contact number with letters', { contactNumber: 'abc12345' }],
    ['a name with numbers', { firstName: 'Lita2' }],
    ['a bad email', { email: 'not-an-email' }],
    ['a future birthdate', { birthDate: '2999-01-01' }],
    ['an impossible birthdate', { birthDate: '2000-02-30' }],
    ['a barangay that does not exist', { barangay: 'Atlantis' }],
  ])('rejects %s with 400 and saves nothing', async (label, extra) => {
    const res = await api(admin).post('/api/residents', newResident(extra));

    expect(res.status).toBe(400);
    expect(await dbRows("SELECT id FROM resident_accounts WHERE last_name = 'Garcia'")).toHaveLength(0);
  });

  it('returns 409 when the email is already used', async () => {
    await api(admin).post('/api/residents', newResident());

    const res = await api(admin).post('/api/residents', newResident());

    expect(res.status).toBe(409);
    expect(await dbRows("SELECT id FROM resident_accounts WHERE email = 'lita.garcia@test.local'")).toHaveLength(1);
  });

  it('keeps barangay staff inside their own barangay', async () => {
    const res = await api(staffBalanti).post('/api/residents', newResident({ barangay: 'Aguso' }));

    expect(res.status).toBe(201);
    const [row] = await dbRows('SELECT barangay FROM resident_accounts WHERE email = ?', ['lita.garcia@test.local']);
    expect(row.barangay).toBe('Balanti');
  });

  it('does not let a resident add residents (403)', async () => {
    const res = await api(residentBalanti).post('/api/residents', newResident());

    expect(res.status).toBe(403);
  });
});

describe('who sees which residents', () => {
  it('shows a city-wide admin every resident', async () => {
    const list = emailsOf(await api(admin).get('/api/residents'));

    expect(list).toEqual(
      expect.arrayContaining([accounts.residentBalanti.email, accounts.residentAguso.email]),
    );
  });

  it('shows barangay staff only residents of their own barangay', async () => {
    const list = emailsOf(await api(staffBalanti).get('/api/residents'));

    expect(list).toContain(accounts.residentBalanti.email);
    expect(list).not.toContain(accounts.residentAguso.email);
  });

  it('never returns password hashes', async () => {
    const res = await api(admin).get('/api/residents');

    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });
});

describe('verifying and updating residents', () => {
  const idOf = async (email) =>
    (await dbRows('SELECT id FROM resident_accounts WHERE email = ?', [email]))[0].id;

  it('lets staff verify a pending resident, who can then sign in', async () => {
    const id = await idOf(accounts.residentPending.email);
    const before = await api().post('/api/auth/login', {
      email: accounts.residentPending.email,
      password: PASSWORD,
    });
    expect(before.status).toBe(403);

    const res = await api(staffBalanti).patch(`/api/residents/${id}/status`, {
      verificationStatus: 'Verified',
      accountStatus: 'Active',
    });

    expect(res.status).toBe(200);
    const after = await api().post('/api/auth/login', {
      email: accounts.residentPending.email,
      password: PASSWORD,
    });
    expect(after.status).toBe(200);
  });

  it('lets staff deactivate a resident, who can then no longer sign in', async () => {
    const id = await idOf(accounts.residentBalanti.email);

    await api(staffBalanti).patch(`/api/residents/${id}/status`, { accountStatus: 'Inactive' });

    const login = await api().post('/api/auth/login', {
      email: accounts.residentBalanti.email,
      password: PASSWORD,
    });
    expect(login.status).toBe(403);
  });

  it('rejects an invalid status with 400', async () => {
    const id = await idOf(accounts.residentPending.email);

    const res = await api(staffBalanti).patch(`/api/residents/${id}/status`, { status: 'Flying' });

    expect(res.status).toBe(400);
  });

  it('stops staff of another barangay from verifying (403)', async () => {
    const id = await idOf(accounts.residentPending.email);

    const res = await api(staffAguso).patch(`/api/residents/${id}/status`, {
      verificationStatus: 'Verified',
      accountStatus: 'Active',
    });

    expect(res.status).toBe(403);
    const [row] = await dbRows('SELECT verification_status FROM resident_accounts WHERE id = ?', [id]);
    expect(row.verification_status).toBe('Pending');
  });

  it('returns 404 for a resident that does not exist', async () => {
    const res = await api(admin).patch('/api/residents/99999/status', { accountStatus: 'Active' });

    expect(res.status).toBe(404);
  });

  it('updates profile details', async () => {
    const id = await idOf(accounts.residentBalanti.email);

    const res = await api(staffBalanti).patch(`/api/residents/${id}`, {
      firstName: 'Juanito',
      lastName: 'Cruz',
      email: accounts.residentBalanti.email,
      barangay: 'Balanti',
      birthDate: '1990-01-01',
      contactNumber: '09171234567',
    });

    expect(res.status).toBe(200);
    const [row] = await dbRows('SELECT first_name, contact_number FROM resident_accounts WHERE id = ?', [id]);
    expect(row).toMatchObject({ first_name: 'Juanito', contact_number: '09171234567' });
  });

  it('stops staff of another barangay from editing a resident (403)', async () => {
    const id = await idOf(accounts.residentBalanti.email);

    const res = await api(staffAguso).patch(`/api/residents/${id}`, {
      firstName: 'Hacked',
      lastName: 'Cruz',
      email: accounts.residentBalanti.email,
      barangay: 'Balanti',
      birthDate: '1990-01-01',
    });

    expect(res.status).toBe(403);
    const [row] = await dbRows('SELECT first_name FROM resident_accounts WHERE id = ?', [id]);
    expect(row.first_name).toBe('Juan');
  });
});
