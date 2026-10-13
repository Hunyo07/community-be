import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs } from './helpers.js';

let admin;
let staff;
let resident;

beforeAll(async () => {
  await resetDatabase();
  admin = await loginAs(accounts.admin.email);
  staff = await loginAs(accounts.staffBalanti.email);
  resident = await loginAs(accounts.residentBalanti.email);
});
afterAll(closePool);

const protectedRoutes = [
  '/api/dashboard/summary',
  '/api/reports/residents',
  '/api/residents',
  '/api/services',
  '/api/service-categories',
  '/api/document-types',
  '/api/requests',
  '/api/barangays',
  '/api/offices',
  '/api/staff',
  '/api/announcements',
  '/api/notifications',
  '/api/audit-logs',
  '/api/settings',
  '/api/profile',
];

describe('every protected route needs a token', () => {
  it.each(protectedRoutes)('GET %s without a token gives 401', async (url) => {
    const res = await api().get(url);
    expect(res.status).toBe(401);
  });
});

describe('role and permission checks (RBAC)', () => {
  it.each([
    '/api/residents',
    '/api/reports/residents',
    '/api/staff',
    '/api/audit-logs',
    '/api/settings',
    '/api/services',
    '/api/offices',
    '/api/barangays',
  ])('a resident is blocked from %s (403)', async (url) => {
    const res = await api(resident).get(url);
    expect(res.status).toBe(403);
  });

  it.each(['/api/document-types', '/api/requests', '/api/announcements', '/api/notifications'])(
    'a resident can open %s',
    async (url) => {
      const res = await api(resident).get(url);
      expect(res.status).toBe(200);
    },
  );

  it.each(['/api/staff', '/api/audit-logs', '/api/settings', '/api/reports/residents'])(
    'barangay staff are blocked from %s (403)',
    async (url) => {
      const res = await api(staff).get(url);
      expect(res.status).toBe(403);
    },
  );

  it.each(['/api/residents', '/api/requests', '/api/offices', '/api/barangays', '/api/announcements'])(
    'barangay staff can open %s',
    async (url) => {
      const res = await api(staff).get(url);
      expect(res.status).toBe(200);
    },
  );

  it.each([
    '/api/residents',
    '/api/requests',
    '/api/staff',
    '/api/offices',
    '/api/barangays',
    '/api/announcements',
    '/api/notifications',
    '/api/audit-logs',
    '/api/settings',
    '/api/document-types',
    '/api/service-categories',
  ])('an admin can open %s', async (url) => {
    const res = await api(admin).get(url);
    expect(res.status).toBe(200);
  });

  it('blocks a resident from creating records that need write permission', async () => {
    const calls = await Promise.all([
      api(resident).post('/api/barangays', { name: 'Hacked' }),
      api(resident).post('/api/offices', { name: 'Hacked', barangay: 'Balanti' }),
      api(resident).post('/api/staff', { name: 'Hacker', email: 'h@test.local' }),
      api(resident).post('/api/announcements', { title: 'Hacked' }),
      api(resident).post('/api/residents', { firstName: 'Hacker' }),
    ]);

    calls.forEach((res) => expect(res.status).toBe(403));
  });

  it('blocks barangay staff from creating barangays, offices, staff and announcements', async () => {
    const calls = await Promise.all([
      api(staff).post('/api/barangays', { name: 'Hacked' }),
      api(staff).post('/api/offices', { name: 'Hacked', barangay: 'Balanti' }),
      api(staff).post('/api/staff', { name: 'Hacker', email: 'h@test.local' }),
      api(staff).post('/api/announcements', { title: 'Hacked' }),
    ]);

    calls.forEach((res) => expect(res.status).toBe(403));
  });

  it('never returns password hashes from the staff list', async () => {
    const res = await api(admin).get('/api/staff');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('only lets an admin read the audit log, and it never contains passwords', async () => {
    const res = await api(admin).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('TestPass123');
  });

  it('cannot create audit log entries through the API', async () => {
    const res = await api(admin).post('/api/audit-logs', { action: 'fake.entry' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
