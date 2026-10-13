import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { api, accounts, resetDatabase, closePool, loginAs, dbRows } from './helpers.js';

let admin;
let staffBalanti;
let staffAguso;
let residentBalanti;
let residentAguso;
let clearanceId;
let othersId;

beforeAll(async () => {
  await resetDatabase();
});
beforeEach(async () => {
  await resetDatabase();
  admin = await loginAs(accounts.admin.email);
  staffBalanti = await loginAs(accounts.staffBalanti.email);
  staffAguso = await loginAs(accounts.staffAguso.email);
  residentBalanti = await loginAs(accounts.residentBalanti.email);
  residentAguso = await loginAs(accounts.residentAguso.email);

  const types = await dbRows('SELECT id, name FROM document_types');
  clearanceId = types.find((t) => t.name === 'Barangay Clearance').id;
  othersId = types.find((t) => t.name === 'Others').id;
});
afterAll(closePool);

const submit = (token, body = {}) =>
  api(token).post('/api/requests', { documentTypeId: clearanceId, description: 'For a job', ...body });

describe('submitting a document request (BB-07, BB-08)', () => {
  it('saves a Submitted request for the signed-in resident', async () => {
    const res = await submit(residentBalanti);

    expect(res.status).toBe(201);
    const [row] = await dbRows('SELECT * FROM service_requests WHERE id = ?', [res.body.data.id]);
    expect(row).toMatchObject({
      status: 'Submitted',
      title: 'Barangay Clearance',
      description: 'For a job',
      document_type_id: clearanceId,
    });
    const [resident] = await dbRows('SELECT id FROM resident_accounts WHERE email = ?', [
      accounts.residentBalanti.email,
    ]);
    expect(row.resident_id).toBe(resident.id);
  });

  it('sends the resident a "submitted" notification', async () => {
    await submit(residentBalanti);

    const notes = await api(residentBalanti).get('/api/notifications');
    expect(notes.status).toBe(200);
    expect(JSON.stringify(notes.body.data)).toContain('Document request submitted');
  });

  it('writes an audit log entry', async () => {
    await submit(residentBalanti);

    const rows = await dbRows("SELECT * FROM audit_logs WHERE action = 'requests.create'");
    expect(rows).toHaveLength(1);
  });

  it('ignores a status sent by the resident and always starts as Submitted', async () => {
    const res = await submit(residentBalanti, { status: 'Completed' });

    const [row] = await dbRows('SELECT status FROM service_requests WHERE id = ?', [res.body.data.id]);
    expect(row.status).toBe('Submitted');
  });

  it.each([
    ['no document type', { documentTypeId: undefined }],
    ['an unknown document type', { documentTypeId: 99999 }],
  ])('rejects %s with 400 and saves nothing', async (label, body) => {
    const res = await submit(residentBalanti, body);

    expect(res.status).toBe(400);
    expect(await dbRows('SELECT id FROM service_requests')).toHaveLength(0);
  });

  it('rejects a deactivated document type', async () => {
    await dbRows("UPDATE document_types SET status = 'Inactive' WHERE id = ?", [clearanceId]);

    const res = await submit(residentBalanti);

    expect(res.status).toBe(400);
    expect(await dbRows('SELECT id FROM service_requests')).toHaveLength(0);
  });

  it('needs a named document for an "Others" request', async () => {
    const empty = await submit(residentBalanti, { documentTypeId: othersId, title: '' });
    expect(empty.status).toBe(400);

    const named = await submit(residentBalanti, { documentTypeId: othersId, title: 'Certificate of Solo Parent' });
    expect(named.status).toBe(201);
    const [row] = await dbRows('SELECT title FROM service_requests WHERE id = ?', [named.body.data.id]);
    expect(row.title).toBe('Certificate of Solo Parent');
  });

  // Known problem found during testing: the server trusts the residentId sent by the client.
  // This test states the CORRECT behavior, so it is marked as an expected failure until the fix.
  it.fails('SECURITY: a resident cannot file a request under another resident', async () => {
    const [other] = await dbRows('SELECT id FROM resident_accounts WHERE email = ?', [
      accounts.residentAguso.email,
    ]);

    const res = await submit(residentBalanti, { residentId: other.id });

    const [row] = await dbRows('SELECT resident_id FROM service_requests WHERE id = ?', [res.body.data.id]);
    expect(row.resident_id).not.toBe(other.id);
  });
});

describe('who sees which requests (barangay scope)', () => {
  let balantiRequest;
  let agusoRequest;

  beforeEach(async () => {
    balantiRequest = (await submit(residentBalanti)).body.data.id;
    agusoRequest = (await submit(residentAguso)).body.data.id;
  });

  const ids = (res) => res.body.data.map((r) => r.id);

  it('shows a resident only their own requests', async () => {
    expect(ids(await api(residentBalanti).get('/api/requests'))).toEqual([balantiRequest]);
    expect(ids(await api(residentAguso).get('/api/requests'))).toEqual([agusoRequest]);
  });

  it('shows barangay staff only requests from their own barangay', async () => {
    expect(ids(await api(staffBalanti).get('/api/requests'))).toEqual([balantiRequest]);
    expect(ids(await api(staffAguso).get('/api/requests'))).toEqual([agusoRequest]);
  });

  it('shows a city-wide admin every request', async () => {
    const list = ids(await api(admin).get('/api/requests'));
    expect(list.sort()).toEqual([balantiRequest, agusoRequest].sort());
  });
});

describe('status workflow (BB-07 to BB-10)', () => {
  let requestId;

  beforeEach(async () => {
    requestId = (await submit(residentBalanti)).body.data.id;
  });

  const setStatus = (token, status, id = requestId) =>
    api(token).patch(`/api/requests/${id}/status`, { status });
  const statusInDb = async () =>
    (await dbRows('SELECT status FROM service_requests WHERE id = ?', [requestId]))[0].status;

  it('lets staff of the same barangay move a request all the way to Claimed', async () => {
    for (const status of ['Under Review', 'Approved', 'Processing', 'Completed', 'Claimed']) {
      const res = await setStatus(staffBalanti, status);
      expect(res.status).toBe(200);
      expect(await statusInDb()).toBe(status);
    }
  });

  it('notifies the resident at every step, with a claim message when Completed', async () => {
    await setStatus(staffBalanti, 'Approved');
    await setStatus(staffBalanti, 'Completed');

    const notes = JSON.stringify((await api(residentBalanti).get('/api/notifications')).body.data);
    expect(notes).toContain('is now Approved');
    expect(notes).toContain('Please claim your document');
  });

  it('shows the resident the new status on their own request list', async () => {
    await setStatus(staffBalanti, 'Approved');

    const list = (await api(residentBalanti).get('/api/requests')).body.data;
    expect(list[0].status).toBe('Approved');
  });

  it('records each change in the audit log', async () => {
    await setStatus(staffBalanti, 'Approved');

    const rows = await dbRows("SELECT * FROM audit_logs WHERE action = 'requests.status_update'");
    expect(rows).toHaveLength(1);
  });

  it('only allows Claimed after Completed', async () => {
    const res = await setStatus(staffBalanti, 'Claimed');

    expect(res.status).toBe(400);
    expect(await statusInDb()).toBe('Submitted');
  });

  it('rejects an invalid status with 400', async () => {
    const res = await setStatus(staffBalanti, 'Teleported');

    expect(res.status).toBe(400);
    expect(await statusInDb()).toBe('Submitted');
  });

  it('returns 404 for a request that does not exist', async () => {
    const res = await setStatus(staffBalanti, 'Approved', 99999);
    expect(res.status).toBe(404);
  });

  it('stops staff of another barangay (403)', async () => {
    const res = await setStatus(staffAguso, 'Approved');

    expect(res.status).toBe(403);
    expect(await statusInDb()).toBe('Submitted');
  });

  it('lets a city-wide admin update any request', async () => {
    const res = await setStatus(admin, 'Approved');
    expect(res.status).toBe(200);
  });

  it('stops a resident from approving their own request (403)', async () => {
    const res = await setStatus(residentBalanti, 'Approved');

    expect(res.status).toBe(403);
    expect(await statusInDb()).toBe('Submitted');
  });

  it('lets a resident cancel their own Submitted request', async () => {
    const res = await setStatus(residentBalanti, 'Cancelled');

    expect(res.status).toBe(200);
    expect(await statusInDb()).toBe('Cancelled');
  });

  it("stops a resident from cancelling someone else's request (403)", async () => {
    const res = await setStatus(residentAguso, 'Cancelled');

    expect(res.status).toBe(403);
    expect(await statusInDb()).toBe('Submitted');
  });

  it('stops a resident from cancelling once staff started working on it', async () => {
    await setStatus(staffBalanti, 'Approved');

    const res = await setStatus(residentBalanti, 'Cancelled');

    expect(res.status).toBe(400);
    expect(await statusInDb()).toBe('Approved');
  });
});

describe('editing request details', () => {
  let requestId;

  beforeEach(async () => {
    requestId = (await submit(residentBalanti)).body.data.id;
  });

  const edit = (token, body = { title: 'Barangay Clearance', description: 'Changed' }) =>
    api(token).patch(`/api/requests/${requestId}`, body);
  const descriptionInDb = async () =>
    (await dbRows('SELECT description FROM service_requests WHERE id = ?', [requestId]))[0].description;

  it('lets the resident edit their own Submitted request', async () => {
    const res = await edit(residentBalanti);

    expect(res.status).toBe(200);
    expect(await descriptionInDb()).toBe('Changed');
  });

  it("stops another resident from editing it (403)", async () => {
    const res = await edit(residentAguso);

    expect(res.status).toBe(403);
    expect(await descriptionInDb()).toBe('For a job');
  });

  it('stops the resident once the request is no longer Submitted', async () => {
    await api(staffBalanti).patch(`/api/requests/${requestId}/status`, { status: 'Approved' });

    const res = await edit(residentBalanti);

    expect(res.status).toBe(400);
    expect(await descriptionInDb()).toBe('For a job');
  });

  it('lets staff of the same barangay edit it', async () => {
    const res = await edit(staffBalanti);
    expect(res.status).toBe(200);
  });

  it('stops staff of another barangay (403)', async () => {
    const res = await edit(staffAguso);

    expect(res.status).toBe(403);
    expect(await descriptionInDb()).toBe('For a job');
  });

  it('rejects an empty title with 400', async () => {
    const res = await edit(residentBalanti, { title: '', description: 'x' });
    expect(res.status).toBe(400);
  });
});
