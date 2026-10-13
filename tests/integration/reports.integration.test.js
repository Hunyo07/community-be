import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows } from './helpers.js';

let admin;
let residentBalanti;
let residentAguso;
let staffBalanti;

beforeAll(async () => {
  await resetDatabase();
  admin = await loginAs(accounts.admin.email);
  residentBalanti = await loginAs(accounts.residentBalanti.email);
  residentAguso = await loginAs(accounts.residentAguso.email);
  staffBalanti = await loginAs(accounts.staffBalanti.email);

  const [type] = await dbRows("SELECT id FROM document_types WHERE name = 'Barangay Clearance'");
  await api(residentBalanti).post('/api/requests', { documentTypeId: type.id, description: 'a' });
  await api(residentBalanti).post('/api/requests', { documentTypeId: type.id, description: 'b' });
  await api(residentAguso).post('/api/requests', { documentTypeId: type.id, description: 'c' });
});
afterAll(closePool);

describe('report generation', () => {
  it.each(['residents', 'requests', 'services', 'beneficiaries', 'barangays', 'staff', 'offices'])(
    'an admin can generate the %s report',
    async (type) => {
      const res = await api(admin).get(`/api/reports/${type}`);

      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
    },
  );

  it('the residents report lists the residents that exist', async () => {
    const res = await api(admin).get('/api/reports/residents');

    const text = JSON.stringify(res.body);
    expect(text).toContain('Juan');
    expect(text).toContain('Maria');
  });

  it('the requests report counts the saved requests', async () => {
    const res = await api(admin).get('/api/reports/requests');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Barangay Clearance');
  });

  it('filters the residents report by barangay', async () => {
    const res = await api(admin).get('/api/reports/residents?barangay=Balanti');

    const text = JSON.stringify(res.body);
    expect(text).toContain('Juan');
    expect(text).not.toContain('Maria');
  });

  it('rejects an unknown report type with 400', async () => {
    const res = await api(admin).get('/api/reports/not-a-report');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unknown report type');
  });

  it('ignores a badly formatted date instead of crashing (no date filter is applied)', async () => {
    const res = await api(admin).get('/api/reports/requests?from=not-a-date');

    expect(res.status).toBe(200);
    expect(res.body.data.filters.from).toBe('');
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  it('shows no requests when the date range is in the future', async () => {
    const res = await api(admin).get('/api/reports/requests?from=2999-01-01&to=2999-12-31');

    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(0);
  });

  it('accepts a valid date range', async () => {
    const res = await api(admin).get('/api/reports/requests?from=2020-01-01&to=2999-12-31');

    expect(res.status).toBe(200);
  });

  it('is blocked for residents and for staff without the reports permission (403)', async () => {
    expect((await api(residentBalanti).get('/api/reports/residents')).status).toBe(403);
    expect((await api(staffBalanti).get('/api/reports/residents')).status).toBe(403);
  });

  it('needs a token (401)', async () => {
    expect((await api().get('/api/reports/residents')).status).toBe(401);
  });

  it('never includes password data', async () => {
    const res = await api(admin).get('/api/reports/residents');

    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });
});
