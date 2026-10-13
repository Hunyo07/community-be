import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows, pool, PASSWORD } from './helpers.js';
import { hashPassword } from '../../src/utils/password.js';

let admin;
let barangayAdmin; // an admin who belongs to Balanti only
let residentBalanti;
let residentAguso;
let staffBalanti;

beforeEach(async () => {
  await resetDatabase();
  await pool.execute(
    `INSERT INTO staff_accounts (name, email, barangay, password_hash, role, permissions, status)
     VALUES ('Barangay Admin', 'badmin@test.local', 'Balanti', ?, 'admin', NULL, 'Active')`,
    [hashPassword(PASSWORD)],
  );
  admin = await loginAs(accounts.admin.email);
  barangayAdmin = await loginAs('badmin@test.local');
  residentBalanti = await loginAs(accounts.residentBalanti.email);
  residentAguso = await loginAs(accounts.residentAguso.email);
  staffBalanti = await loginAs(accounts.staffBalanti.email);
});
afterAll(closePool);

const announcement = (extra = {}) => ({
  title: 'Water interruption',
  content: 'No water tomorrow',
  audience: 'All',
  status: 'Published',
  ...extra,
});
const titlesOf = (res) => res.body.data.map((a) => a.title);

describe('creating announcements', () => {
  it('lets a city-wide admin publish a city-wide announcement that every resident sees', async () => {
    const res = await api(admin).post('/api/announcements', announcement({ title: 'City-wide notice' }));

    expect(res.status).toBe(201);
    expect(titlesOf(await api(residentBalanti).get('/api/announcements'))).toContain('City-wide notice');
    expect(titlesOf(await api(residentAguso).get('/api/announcements'))).toContain('City-wide notice');
  });

  it('shows an announcement for one barangay only to residents of that barangay', async () => {
    await api(admin).post('/api/announcements', announcement({ title: 'Balanti only', barangay: 'Balanti' }));

    expect(titlesOf(await api(residentBalanti).get('/api/announcements'))).toContain('Balanti only');
    expect(titlesOf(await api(residentAguso).get('/api/announcements'))).not.toContain('Balanti only');
  });

  it('notifies verified residents of that barangay only', async () => {
    await api(admin).post('/api/announcements', announcement({ title: 'Balanti only', barangay: 'Balanti' }));

    const balanti = JSON.stringify((await api(residentBalanti).get('/api/notifications')).body.data);
    const aguso = JSON.stringify((await api(residentAguso).get('/api/notifications')).body.data);
    expect(balanti).toContain('Balanti only');
    expect(aguso).not.toContain('Balanti only');
  });

  it('does not notify unverified residents', async () => {
    await api(admin).post('/api/announcements', announcement({ title: 'For everyone' }));

    const rows = await dbRows(
      `SELECT n.id FROM notifications n
       JOIN resident_accounts r ON r.id = n.user_id
       WHERE r.email = ?`,
      [accounts.residentPending.email],
    );
    expect(rows).toHaveLength(0);
  });

  it('hides drafts from residents', async () => {
    await api(admin).post('/api/announcements', announcement({ title: 'Secret draft', status: 'Draft' }));

    expect(titlesOf(await api(residentBalanti).get('/api/announcements'))).not.toContain('Secret draft');
    expect(titlesOf(await api(admin).get('/api/announcements'))).toContain('Secret draft');
  });

  it('hides announcements that already expired', async () => {
    await api(admin).post(
      '/api/announcements',
      announcement({ title: 'Old news', expiresAt: '2020-01-01 00:00:00' }),
    );

    expect(titlesOf(await api(residentBalanti).get('/api/announcements'))).not.toContain('Old news');
  });

  it('only shows Admins-only announcements to admins', async () => {
    await api(admin).post('/api/announcements', announcement({ title: 'Admins only', audience: 'Admins' }));

    expect(titlesOf(await api(residentBalanti).get('/api/announcements'))).not.toContain('Admins only');
    expect(titlesOf(await api(staffBalanti).get('/api/announcements'))).not.toContain('Admins only');
  });

  it('rejects an unknown barangay with 400 and saves nothing', async () => {
    const res = await api(admin).post('/api/announcements', announcement({ barangay: 'Atlantis' }));

    expect(res.status).toBe(400);
    expect(await dbRows('SELECT id FROM announcements')).toHaveLength(0);
  });

  it('forces a barangay admin to publish for their own barangay', async () => {
    await api(barangayAdmin).post('/api/announcements', announcement({ title: 'Mine', barangay: 'Aguso' }));

    const [row] = await dbRows("SELECT barangay FROM announcements WHERE title = 'Mine'");
    expect(row.barangay).toBe('Balanti');
  });

  it('writes an audit log entry', async () => {
    await api(admin).post('/api/announcements', announcement());

    expect(await dbRows("SELECT id FROM audit_logs WHERE action = 'announcements.create'")).toHaveLength(1);
  });

  it('blocks barangay staff from publishing (403)', async () => {
    const res = await api(staffBalanti).post('/api/announcements', announcement());

    expect(res.status).toBe(403);
  });
});

describe('editing and deleting announcements', () => {
  let aguso;
  let balanti;

  beforeEach(async () => {
    aguso = (await api(admin).post('/api/announcements', announcement({ title: 'Aguso', barangay: 'Aguso' }))).body.data.id;
    balanti = (await api(admin).post('/api/announcements', announcement({ title: 'Balanti', barangay: 'Balanti' }))).body.data.id;
  });

  it('lets a barangay admin edit an announcement of their own barangay', async () => {
    const res = await api(barangayAdmin).patch(`/api/announcements/${balanti}`, announcement({ title: 'Balanti edited' }));

    expect(res.status).toBe(200);
    const [row] = await dbRows('SELECT title FROM announcements WHERE id = ?', [balanti]);
    expect(row.title).toBe('Balanti edited');
  });

  it('stops a barangay admin from editing another barangay (403)', async () => {
    const res = await api(barangayAdmin).patch(`/api/announcements/${aguso}`, announcement({ title: 'Hacked' }));

    expect(res.status).toBe(403);
    const [row] = await dbRows('SELECT title FROM announcements WHERE id = ?', [aguso]);
    expect(row.title).toBe('Aguso');
  });

  it('stops a barangay admin from deleting another barangay (403)', async () => {
    const res = await api(barangayAdmin).delete(`/api/announcements/${aguso}`);

    expect(res.status).toBe(403);
    expect(await dbRows('SELECT id FROM announcements WHERE id = ?', [aguso])).toHaveLength(1);
  });

  it('lets a barangay admin delete an announcement of their own barangay', async () => {
    const res = await api(barangayAdmin).delete(`/api/announcements/${balanti}`);

    expect(res.status).toBe(200);
    expect(await dbRows('SELECT id FROM announcements WHERE id = ?', [balanti])).toHaveLength(0);
  });

  it('lets a city-wide admin delete any announcement and logs it', async () => {
    const res = await api(admin).delete(`/api/announcements/${aguso}`);

    expect(res.status).toBe(200);
    expect(await dbRows("SELECT id FROM audit_logs WHERE action = 'announcements.delete'")).toHaveLength(1);
  });

  it('returns 404 when deleting one that does not exist', async () => {
    const res = await api(admin).delete('/api/announcements/99999');

    expect(res.status).toBe(404);
  });

  it('returns 404 for the poster of an announcement without one', async () => {
    const res = await api(admin).get(`/api/announcements/${balanti}/poster`);

    expect(res.status).toBe(404);
  });
});

describe('offices and the barangay scope', () => {
  const office = (extra = {}) => ({ name: 'Health Office', barangay: 'Aguso', description: 'Health', ...extra });

  it('lets a city-wide admin create an office in any known barangay', async () => {
    const res = await api(admin).post('/api/offices', office());

    expect(res.status).toBe(201);
    const [row] = await dbRows("SELECT barangay FROM offices WHERE name = 'Health Office'");
    expect(row.barangay).toBe('Aguso');
  });

  it('rejects an unknown barangay and a missing barangay with 400', async () => {
    expect((await api(admin).post('/api/offices', office({ barangay: 'Atlantis' }))).status).toBe(400);
    expect((await api(admin).post('/api/offices', office({ barangay: '' }))).status).toBe(400);
    expect(await dbRows('SELECT id FROM offices')).toHaveLength(0);
  });

  it('forces a barangay admin to create offices in their own barangay', async () => {
    await api(barangayAdmin).post('/api/offices', office({ barangay: 'Aguso' }));

    const [row] = await dbRows("SELECT barangay FROM offices WHERE name = 'Health Office'");
    expect(row.barangay).toBe('Balanti');
  });

  it('lists only the offices of their own barangay for barangay staff', async () => {
    await api(admin).post('/api/offices', office({ name: 'Aguso Office', barangay: 'Aguso' }));
    await api(admin).post('/api/offices', office({ name: 'Balanti Office', barangay: 'Balanti' }));

    const names = (await api(staffBalanti).get('/api/offices')).body.data.map((o) => o.name);

    expect(names).toEqual(['Balanti Office']);
  });

  it('stops a barangay admin from editing an office of another barangay (403)', async () => {
    const id = (await api(admin).post('/api/offices', office({ name: 'Aguso Office' }))).body.data.id;

    const res = await api(barangayAdmin).patch(`/api/offices/${id}`, office({ name: 'Hacked' }));

    expect(res.status).toBe(403);
    const [row] = await dbRows('SELECT name FROM offices WHERE id = ?', [id]);
    expect(row.name).toBe('Aguso Office');
  });

  it('can deactivate an office', async () => {
    const id = (await api(admin).post('/api/offices', office())).body.data.id;

    const res = await api(admin).patch(`/api/offices/${id}`, office({ status: 'Inactive' }));

    expect(res.status).toBe(200);
    const [row] = await dbRows('SELECT status FROM offices WHERE id = ?', [id]);
    expect(row.status).toBe('Inactive');
  });
});
