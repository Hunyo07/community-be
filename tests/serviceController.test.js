import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace everything the controller talks to with fakes before it loads.
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn(), query: vi.fn() },
}));
vi.mock('../src/realtime/socket.js', () => ({
  emitRealtimeEvent: vi.fn(),
}));
vi.mock('../src/utils/auditLogger.js', () => ({
  logAudit: vi.fn(),
}));
vi.mock('../src/utils/settings.js', () => ({
  getSettingValue: vi.fn(),
}));
vi.mock('../src/utils/residentName.js', () => ({
  formatResidentName: (first, middle, last) =>
    [first, middle, last].filter(Boolean).join(' '),
}));

import { pool } from '../src/config/db.js';
import { emitRealtimeEvent } from '../src/realtime/socket.js';
import { logAudit } from '../src/utils/auditLogger.js';
import { getSettingValue } from '../src/utils/settings.js';
import {
  getServices,
  getServiceDirectory,
  createService,
  updateService,
  getServiceDetails,
  changeServiceStatus,
  getServiceChecklist,
  updateServiceBeneficiary,
  resetServiceBeneficiary,
  getServedBeneficiaries,
  getNotYetServedResidents,
  exportServicesSummaryCsv,
  exportServiceChecklistCsv,
  exportServiceBeneficiariesCsv,
  exportServiceNotYetServedCsv,
} from '../src/controllers/serviceController.js';

// ---------- helpers ----------

// Builds a fake Express response (supports JSON and CSV downloads).
const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const admin = {
  id: 1,
  name: 'Ana Admin',
  email: 'ana@example.com',
  role: 'admin',
  permissions: [],
};

const staff = (overrides = {}) => ({
  id: 2,
  name: 'Sam Staff',
  email: 'sam@example.com',
  role: 'barangay_staff',
  barangay: 'Balanti',
  officeId: 2,
  permissions: [],
  ...overrides,
});

const resident = { id: 9, role: 'resident', barangay: 'Balanti' };

// A services row as the database would return it.
const serviceRow = (overrides = {}) => ({
  id: 5,
  name: 'Free Medical Checkup',
  category: 'Health',
  barangay: 'Balanti',
  office_id: null,
  office_name: null,
  visibility: 'own_barangay',
  description: null,
  target_scope: 'All Residents',
  start_date: null,
  end_date: null,
  remarks: null,
  target_beneficiaries: 100,
  served_count: 25,
  target_residents: 100,
  pending_requests: 0,
  status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

// A resident checklist row as the database would return it.
const resRow = (overrides = {}) => ({
  resident_id: 12,
  first_name: 'Juan',
  middle_name: null,
  last_name: 'Cruz',
  email: 'juan@example.com',
  contact_number: '09171234567',
  barangay: 'Balanti',
  age: 30,
  gender: 'Male',
  purok_sitio: 'Purok 1',
  beneficiary_status: null,
  served_at: null,
  processed_by_name: null,
  remarks: null,
  ...overrides,
});

// Sets up a fake database that answers by recognizing the SQL text.
const setupDb = (overrides = {}) => {
  const state = {
    service: serviceRow(),
    list: [],
    checklist: [],
    resident: { id: 12, barangay: 'Balanti' },
    office: null,
    categories: ['Health', 'Education'],
    insertId: 10,
    ...overrides,
  };

  pool.execute.mockImplementation(async (sql) => {
    if (sql.includes('SELECT id, barangay, status FROM offices')) {
      return [state.office ? [state.office] : []];
    }
    if (sql.includes('WHERE services.id = ?')) {
      return [state.service ? [state.service] : []];
    }
    if (sql.includes('SELECT id, barangay FROM resident_accounts')) {
      return [state.resident ? [state.resident] : []];
    }
    if (sql.includes('FROM resident_accounts ra')) {
      return [state.checklist];
    }
    if (sql.includes('ORDER BY services.created_at DESC')) {
      return [state.list];
    }
    if (sql.includes('INSERT INTO services')) {
      return [{ insertId: state.insertId }];
    }
    return [{ affectedRows: 1 }];
  });

  pool.query.mockResolvedValue([state.categories.map((name) => ({ name }))]);
};

// Finds the first database call whose SQL contains the given text.
const callFor = (text) =>
  pool.execute.mock.calls.find(([sql]) => sql.includes(text));

const listCall = () => callFor('ORDER BY services.created_at DESC');

// Runs a controller function with a fake request and returns { res, next }.
const run = async (handler, req = {}) => {
  const res = createRes();
  const next = vi.fn();
  await handler(
    { user: admin, query: {}, params: {}, body: {}, ...req },
    res,
    next,
  );
  return { res, next };
};

const ID = { id: '5' };
const BENEFICIARY = { id: '5', residentId: '12' };

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  logAudit.mockReset();
  emitRealtimeEvent.mockReset();
  getSettingValue.mockReset();
  getSettingValue.mockResolvedValue('own_barangay');
  setupDb();
});

// ---------- createService ----------

describe('createService: saving', () => {
  const body = { name: 'Flu Shots', category: 'Health', barangay: 'Balanti' };

  beforeEach(() => {
    setupDb({ service: serviceRow({ id: 10, name: 'Flu Shots' }) });
  });

  it('creates the service and responds with 201', async () => {
    const { res, next } = await run(createService, { body });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      id: 'SRV-010',
      rawId: 10,
      name: 'Flu Shots',
    });
  });

  it('saves every value in the right order with a safe query', async () => {
    await run(createService, { body });

    const [sql, params] = callFor('INSERT INTO services');
    expect(sql).not.toContain('Flu Shots');
    expect(params).toEqual([
      'Flu Shots',
      'Health',
      'Balanti',
      null,
      'own_barangay',
      '',
      'All Residents',
      null,
      null,
      '',
      0,
      0,
      'Active',
    ]);
  });

  it('uses the default visibility from system settings', async () => {
    getSettingValue.mockResolvedValue('public');

    await run(createService, { body });

    expect(getSettingValue).toHaveBeenCalledWith(
      'default_service_visibility',
      'own_barangay',
    );
    expect(callFor('INSERT INTO services')[1][4]).toBe('public');
  });

  it('lets the request choose its own visibility', async () => {
    await run(createService, { body: { ...body, visibility: 'all_barangays' } });
    expect(callFor('INSERT INTO services')[1][4]).toBe('all_barangays');
  });

  it('turns empty dates into null and keeps real dates', async () => {
    await run(createService, {
      body: { ...body, startDate: '2026-03-01', endDate: '' },
    });

    const params = callFor('INSERT INTO services')[1];
    expect(params[7]).toBe('2026-03-01');
    expect(params[8]).toBeNull();
  });

  it('converts counts written as text into numbers', async () => {
    await run(createService, {
      body: { ...body, targetBeneficiaries: '50', pendingRequests: '3' },
    });

    const params = callFor('INSERT INTO services')[1];
    expect(params[10]).toBe(50);
    expect(params[11]).toBe(3);
  });

  it('accepts a target of 0', async () => {
    const { next } = await run(createService, {
      body: { ...body, targetBeneficiaries: 0 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(createService, { body });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'services.create',
        entityType: 'services',
        entityId: 10,
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'services:changed',
      expect.objectContaining({ action: 'created' }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'service-created',
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(createService, { body });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('createService: validation', () => {
  const valid = { name: 'Flu Shots', category: 'Health', barangay: 'Balanti' };

  const expectRejected = async (body, message) => {
    const { res, next } = await run(createService, { body });

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(message);
    expect(res.status).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO services')).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  };

  const required = 'Name, category, and assigned barangay are required';

  it('rejects a missing name', async () => {
    await expectRejected({ ...valid, name: '' }, required);
  });

  it('rejects a missing category', async () => {
    await expectRejected({ ...valid, category: undefined }, required);
  });

  it('rejects a missing barangay', async () => {
    await expectRejected({ ...valid, barangay: undefined }, required);
  });

  it('rejects "All Barangays" as the assigned barangay', async () => {
    await expectRejected({ ...valid, barangay: 'All Barangays' }, required);
  });

  it('rejects a category that is not on the active list', async () => {
    await expectRejected(
      { ...valid, category: 'Gambling' },
      'Invalid service category',
    );
  });

  it('rejects a category that was deactivated', async () => {
    setupDb({ categories: ['Health'] });
    await expectRejected(
      { ...valid, category: 'Education' },
      'Invalid service category',
    );
  });

  it('rejects an unknown status', async () => {
    await expectRejected({ ...valid, status: 'Archived' }, 'Invalid service status');
  });

  it('rejects an unknown visibility', async () => {
    await expectRejected(
      { ...valid, visibility: 'secret' },
      'Invalid service visibility',
    );
  });

  it('rejects a negative target', async () => {
    await expectRejected(
      { ...valid, targetBeneficiaries: -1 },
      'Beneficiary counts must be zero or greater',
    );
  });

  it('rejects negative pending requests', async () => {
    await expectRejected(
      { ...valid, pendingRequests: -5 },
      'Beneficiary counts must be zero or greater',
    );
  });

  it.each(['Active', 'Inactive', 'Completed'])(
    'accepts the status %s',
    async (status) => {
      const { next } = await run(createService, { body: { ...valid, status } });
      expect(next).not.toHaveBeenCalled();
    },
  );
});

describe('createService: barangay staff scope', () => {
  const body = { name: 'Flu Shots', category: 'Health' };

  it('forces the staff member\'s own barangay', async () => {
    await run(createService, {
      user: staff(),
      body: { ...body, barangay: 'Other Barangay' },
    });

    expect(callFor('INSERT INTO services')[1][2]).toBe('Balanti');
  });

  it('forces the staff member\'s own office without the assign permission', async () => {
    await run(createService, { user: staff(), body: { ...body, officeId: 99 } });
    expect(callFor('INSERT INTO services')[1][3]).toBe(2);
  });

  it('lets staff with the assign permission choose an office in their barangay', async () => {
    setupDb({ office: { id: 4, barangay: 'Balanti', status: 'Active' } });

    await run(createService, {
      user: staff({ permissions: ['services:assign_office'] }),
      body: { ...body, officeId: 4 },
    });

    expect(callFor('INSERT INTO services')[1][3]).toBe(4);
  });

  it('allows no office at all for staff with the assign permission', async () => {
    const { next } = await run(createService, {
      user: staff({ permissions: ['services:assign_office'] }),
      body,
    });

    expect(next).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO services')[1][3]).toBeNull();
  });

  it('rejects an office in another barangay with 403', async () => {
    setupDb({ office: { id: 4, barangay: 'Other', status: 'Active' } });

    const { next } = await run(createService, {
      user: staff({ permissions: ['services:assign_office'] }),
      body: { ...body, officeId: 4 },
    });

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Barangay staff can only assign services to offices in their assigned barangay',
    );
    expect(callFor('INSERT INTO services')).toBeUndefined();
  });

  it('rejects an inactive office with 400', async () => {
    setupDb({ office: { id: 4, barangay: 'Balanti', status: 'Inactive' } });

    const { next } = await run(createService, {
      user: staff({ permissions: ['services:assign_office'] }),
      body: { ...body, officeId: 4 },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toBe('Selected office is not available');
  });

  it('rejects an office that does not exist with 400', async () => {
    setupDb({ office: null });

    const { next } = await run(createService, {
      user: staff({ permissions: ['services:assign_office'] }),
      body: { ...body, officeId: 404 },
    });

    expect(next.mock.calls[0][0].message).toBe('Selected office is not available');
  });
});

// ---------- updateService ----------

describe('updateService', () => {
  it('returns 404 when the service does not exist', async () => {
    setupDb({ service: null });

    const { res, next } = await run(updateService, {
      params: ID,
      body: { name: 'New' },
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Service not found' });
    expect(next).not.toHaveBeenCalled();
    expect(callFor('UPDATE services')).toBeUndefined();
  });

  it('changes only what was sent and keeps the rest', async () => {
    await run(updateService, { params: ID, body: { name: 'Renamed' } });

    const [sql, params] = callFor('UPDATE services');
    expect(sql).not.toContain('Renamed');
    expect(params[0]).toBe('Renamed');
    expect(params[1]).toBe('Health');
    expect(params[2]).toBe('Balanti');
    expect(params[4]).toBe('own_barangay');
    expect(params[12]).toBe('Active');
    expect(params.at(-1)).toBe('5');
  });

  it('responds with the updated service', async () => {
    const { res, next } = await run(updateService, {
      params: ID,
      body: { name: 'Renamed' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].data).toMatchObject({ rawId: 5 });
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(updateService, { params: ID, body: { name: 'Renamed' } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'services.update',
        entityType: 'services',
        entityId: '5',
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'services:changed',
      expect.objectContaining({ action: 'updated' }),
    );
  });

  it('rejects an invalid status with 400 and saves nothing', async () => {
    const { next } = await run(updateService, {
      params: ID,
      body: { status: 'Archived' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(callFor('UPDATE services')).toBeUndefined();
  });

  it('lets an admin move a service to another barangay', async () => {
    await run(updateService, { params: ID, body: { barangay: 'San Nicolas' } });
    expect(callFor('UPDATE services')[1][2]).toBe('San Nicolas');
  });

  it('keeps staff from moving a service to another barangay', async () => {
    await run(updateService, {
      user: staff(),
      params: ID,
      body: { barangay: 'Other Barangay' },
    });

    expect(callFor('UPDATE services')[1][2]).toBe('Balanti');
  });

  it('blocks staff from editing a service in another barangay', async () => {
    setupDb({ service: serviceRow({ barangay: 'Other Barangay' }) });

    const { next } = await run(updateService, {
      user: staff(),
      params: ID,
      body: { name: 'Hijacked' },
    });

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('You do not have permission to manage this service');
    expect(callFor('UPDATE services')).toBeUndefined();
  });
});

// ---------- changeServiceStatus ----------

describe('changeServiceStatus', () => {
  it.each(['Active', 'Inactive', 'Completed'])(
    'sets the status to %s',
    async (status) => {
      const { res, next } = await run(changeServiceStatus, {
        params: ID,
        body: { status },
      });

      const [sql, params] = callFor('UPDATE services SET status');
      expect(sql).toContain('?');
      expect(params).toEqual([status, 5]);
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['Archived', 'active', '', undefined])(
    'rejects the status %s with 400',
    async (status) => {
      const { res } = await run(changeServiceStatus, {
        params: ID,
        body: { status },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid service status' });
      expect(callFor('UPDATE services')).toBeUndefined();
    },
  );

  it('passes a 404 error to next when the service does not exist', async () => {
    setupDb({ service: null });

    const { next } = await run(changeServiceStatus, {
      params: ID,
      body: { status: 'Active' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(404);
    expect(next.mock.calls[0][0].message).toBe('Service not found');
  });

  it('blocks staff from another barangay with 403', async () => {
    setupDb({ service: serviceRow({ barangay: 'Other Barangay' }) });

    const { next } = await run(changeServiceStatus, {
      user: staff(),
      params: ID,
      body: { status: 'Inactive' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(callFor('UPDATE services')).toBeUndefined();
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(changeServiceStatus, { params: ID, body: { status: 'Completed' } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'services.status_update',
        entityId: 5,
        details: { status: 'Completed' },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'services:changed',
      expect.objectContaining({ action: 'status-updated' }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'service-status-updated',
    });
  });
});

// ---------- beneficiary tracking ----------

describe('updateServiceBeneficiary', () => {
  beforeEach(() => {
    setupDb({
      checklist: [resRow({ resident_id: 12, beneficiary_status: 'Served' })],
    });
  });

  it('marks a resident as served with who processed it', async () => {
    await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served', remarks: 'Delivered' },
    });

    const [sql, params] = callFor('INSERT INTO service_beneficiaries');
    expect(sql).toContain('?');
    expect(params[0]).toBe(5);
    expect(params[1]).toBe('12');
    expect(params[2]).toBe('Served');
    expect(params[3]).toBeInstanceOf(Date);
    expect(params[4]).toBe(1);
    expect(params[5]).toBe('Ana Admin');
    expect(params[6]).toBe('Delivered');
  });

  it.each(['Pending', 'Skipped', 'Not Eligible'])(
    'saves %s without a date served',
    async (status) => {
      await run(updateServiceBeneficiary, { params: BENEFICIARY, body: { status } });
      expect(callFor('INSERT INTO service_beneficiaries')[1][3]).toBeNull();
    },
  );

  it('uses an empty remark when none is sent', async () => {
    await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served' },
    });
    expect(callFor('INSERT INTO service_beneficiaries')[1][6]).toBe('');
  });

  it('falls back to the email when the user has no name', async () => {
    await run(updateServiceBeneficiary, {
      user: { id: 3, email: 'x@example.com', role: 'admin' },
      params: BENEFICIARY,
      body: { status: 'Served' },
    });
    expect(callFor('INSERT INTO service_beneficiaries')[1][5]).toBe('x@example.com');
  });

  it.each(['Not Served', 'served', 'Done', '', undefined])(
    'rejects the status %s with 400',
    async (status) => {
      const { res } = await run(updateServiceBeneficiary, {
        params: BENEFICIARY,
        body: { status },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid beneficiary status' });
      expect(callFor('INSERT INTO service_beneficiaries')).toBeUndefined();
    },
  );

  it('returns 404 when the resident does not exist', async () => {
    setupDb({ resident: null });

    const { res } = await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served' },
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident not found' });
    expect(callFor('INSERT INTO service_beneficiaries')).toBeUndefined();
  });

  it('rejects a resident from a different barangay with 400', async () => {
    setupDb({ resident: { id: 12, barangay: 'Other Barangay' } });

    const { res } = await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Resident does not belong to this service barangay',
    });
    expect(callFor('INSERT INTO service_beneficiaries')).toBeUndefined();
  });

  it('passes a 404 error to next when the service does not exist', async () => {
    setupDb({ service: null });

    const { next } = await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('responds with the updated resident', async () => {
    const { res } = await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served' },
    });

    expect(res.json.mock.calls[0][0].data).toMatchObject({
      residentId: 12,
      residentCode: 'RES-0012',
      name: 'Juan Cruz',
      beneficiaryStatus: 'Served',
    });
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(updateServiceBeneficiary, {
      params: BENEFICIARY,
      body: { status: 'Served', remarks: 'Delivered' },
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'services.beneficiary_update',
        entityType: 'service_beneficiaries',
        entityId: '12',
        details: { serviceId: 5, status: 'Served', remarks: 'Delivered' },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'service-beneficiary-updated',
    });
  });
});

describe('resetServiceBeneficiary', () => {
  it('deletes the record so the resident shows as not served', async () => {
    const { res } = await run(resetServiceBeneficiary, { params: BENEFICIARY });

    const [sql, params] = callFor('DELETE FROM service_beneficiaries');
    expect(sql).toContain('?');
    expect(params).toEqual([5, '12']);
    expect(res.json).toHaveBeenCalledWith({
      data: { residentId: 12, beneficiaryStatus: 'Not Served' },
    });
  });

  it('records an audit entry', async () => {
    await run(resetServiceBeneficiary, { params: BENEFICIARY });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'services.beneficiary_reset',
        entityId: '12',
        details: { serviceId: 5 },
      }),
    );
  });

  it('passes a 404 error to next when the service does not exist', async () => {
    setupDb({ service: null });

    const { next } = await run(resetServiceBeneficiary, { params: BENEFICIARY });

    expect(next.mock.calls[0][0].statusCode).toBe(404);
    expect(callFor('DELETE FROM service_beneficiaries')).toBeUndefined();
  });
});

// ---------- listing and scope ----------

describe('getServices: who sees what', () => {
  it('shows everything to an admin', async () => {
    await run(getServices, { user: admin });
    expect(listCall()[1]).toEqual([]);
  });

  it('limits staff to their barangay and office', async () => {
    await run(getServices, { user: staff() });

    const [sql, params] = listCall();
    expect(sql).toContain('services.barangay = ?');
    expect(sql).toContain('services.office_id IS NULL');
    expect(params).toEqual(['Balanti', 2]);
  });

  it('uses 0 as the office when staff have no office', async () => {
    await run(getServices, { user: staff({ officeId: null }) });
    expect(listCall()[1]).toEqual(['Balanti', 0]);
  });

  it('shows all offices in the barangay to staff with that permission', async () => {
    await run(getServices, {
      user: staff({ permissions: ['services:view_all_offices'] }),
    });
    expect(listCall()[1]).toEqual(['Balanti']);
  });

  it('shows every barangay to staff with that permission', async () => {
    await run(getServices, {
      user: staff({ permissions: ['services:view_all_barangays'] }),
    });
    expect(listCall()[1]).toEqual([]);
  });

  it('shows residents only active services for their barangay or shared ones', async () => {
    await run(getServices, { user: resident });

    const [sql, params] = listCall();
    expect(sql).toContain("services.visibility IN ('all_barangays', 'public')");
    expect(sql).toContain("services.status = 'Active'");
    expect(params).toEqual(['Balanti']);
  });
});

describe('getServices: filters', () => {
  it('searches name, category, and barangay with a trimmed term', async () => {
    await run(getServices, { query: { search: '  flu  ' } });
    expect(listCall()[1]).toEqual(['%flu%', '%flu%', '%flu%']);
  });

  it('ignores a blank search', async () => {
    await run(getServices, { query: { search: '   ' } });
    expect(listCall()[1]).toEqual([]);
  });

  it('keeps search text out of the SQL', async () => {
    const attack = "'; DROP TABLE services;--";
    await run(getServices, { query: { search: attack } });

    const [sql, params] = listCall();
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain(`%${attack}%`);
  });

  it('applies category, status, and barangay filters in order', async () => {
    await run(getServices, {
      query: { category: 'Health', status: 'Active', barangay: 'Balanti' },
    });
    expect(listCall()[1]).toEqual(['Health', 'Active', 'Balanti']);
  });

  it('combines the staff scope with a search', async () => {
    await run(getServices, { user: staff(), query: { search: 'x' } });
    expect(listCall()[1]).toEqual(['Balanti', 2, '%x%', '%x%', '%x%']);
  });

  describe('coverage', () => {
    beforeEach(() => {
      setupDb({
        list: [
          serviceRow({ id: 1, served_count: 0, target_residents: 100 }),
          serviceRow({ id: 2, served_count: 50, target_residents: 100 }),
          serviceRow({ id: 3, served_count: 100, target_residents: 100 }),
        ],
      });
    });

    const ids = (res) => res.json.mock.calls[0][0].data.map((s) => s.rawId);

    it('returns everything when no coverage filter is given', async () => {
      const { res } = await run(getServices, {});
      expect(ids(res)).toEqual([1, 2, 3]);
    });

    it('not_started returns services with nobody served', async () => {
      const { res } = await run(getServices, { query: { coverage: 'not_started' } });
      expect(ids(res)).toEqual([1]);
    });

    it('in_progress returns services between 0% and 100%', async () => {
      const { res } = await run(getServices, { query: { coverage: 'in_progress' } });
      expect(ids(res)).toEqual([2]);
    });

    it('complete returns services at 100%', async () => {
      const { res } = await run(getServices, { query: { coverage: 'complete' } });
      expect(ids(res)).toEqual([3]);
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(getServices, {});

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('getServices: service details in the response', () => {
  const firstService = async (row) => {
    setupDb({ list: [row] });
    const { res } = await run(getServices, {});
    return res.json.mock.calls[0][0].data[0];
  };

  it('formats the service id with leading zeros', async () => {
    expect((await firstService(serviceRow({ id: 5 }))).id).toBe('SRV-005');
    expect((await firstService(serviceRow({ id: 123 }))).id).toBe('SRV-123');
    expect((await firstService(serviceRow({ id: 1234 }))).id).toBe('SRV-1234');
  });

  it('works out the remaining count and progress', async () => {
    const service = await firstService(
      serviceRow({ served_count: 25, target_residents: 100 }),
    );

    expect(service).toMatchObject({
      beneficiaries: 25,
      targetBeneficiaries: 100,
      remainingBeneficiaries: 75,
      beneficiaryProgress: 25,
    });
  });

  it('never goes below 0 remaining or above 100% progress', async () => {
    const service = await firstService(
      serviceRow({ served_count: 120, target_residents: 100 }),
    );

    expect(service.remainingBeneficiaries).toBe(0);
    expect(service.beneficiaryProgress).toBe(100);
  });

  it('shows 0% progress when the target is 0', async () => {
    const service = await firstService(
      serviceRow({ served_count: 5, target_residents: 0, target_beneficiaries: 0 }),
    );

    expect(service.beneficiaryProgress).toBe(0);
    expect(service.remainingBeneficiaries).toBe(0);
  });

  it('rounds progress to a whole number', async () => {
    const service = await firstService(
      serviceRow({ served_count: 1, target_residents: 3 }),
    );
    expect(service.beneficiaryProgress).toBe(33);
  });

  it('uses the stored target when the resident count is missing', async () => {
    const service = await firstService(
      serviceRow({ target_residents: undefined, target_beneficiaries: 50 }),
    );
    expect(service.targetBeneficiaries).toBe(50);
  });

  it('fills in defaults for empty fields', async () => {
    const service = await firstService(
      serviceRow({ description: null, target_scope: null, remarks: null }),
    );

    expect(service).toMatchObject({
      description: '',
      targetScope: 'All Residents',
      remarks: '',
      officeName: '',
      startDate: '',
      endDate: '',
    });
  });

  it('keeps only the date part of date text', async () => {
    const service = await firstService(
      serviceRow({
        start_date: '2026-03-01T00:00:00.000Z',
        end_date: '2026-03-31',
      }),
    );

    expect(service.startDate).toBe('2026-03-01');
    expect(service.endDate).toBe('2026-03-31');
  });
});

describe('getServiceDirectory', () => {
  it('shows only shared services to staff and admins', async () => {
    await run(getServiceDirectory, { user: admin });

    const [sql, params] = listCall();
    expect(sql).toContain("services.visibility IN ('all_barangays', 'public')");
    expect(params).toEqual([]);
  });

  it('shows residents only public, active services', async () => {
    await run(getServiceDirectory, { user: resident });

    const sql = listCall()[0];
    expect(sql).toContain("services.visibility = 'public'");
    expect(sql).toContain("services.status = 'Active'");
  });

  it('searches services and office names', async () => {
    await run(getServiceDirectory, { query: { search: 'flu' } });
    expect(listCall()[1]).toEqual(['%flu%', '%flu%', '%flu%', '%flu%']);
  });

  it('applies a valid visibility filter', async () => {
    await run(getServiceDirectory, { query: { visibility: 'public' } });
    expect(listCall()[1]).toEqual(['public']);
  });

  it('ignores an invalid visibility filter', async () => {
    await run(getServiceDirectory, { query: { visibility: 'secret' } });
    expect(listCall()[1]).toEqual([]);
  });
});

// ---------- details, summary, and checklist ----------

describe('getServiceDetails', () => {
  it('returns the service with a beneficiary summary', async () => {
    setupDb({
      checklist: [
        resRow({ resident_id: 1, beneficiary_status: 'Served' }),
        resRow({ resident_id: 2, beneficiary_status: 'Served' }),
        resRow({ resident_id: 3, beneficiary_status: 'Pending' }),
        resRow({ resident_id: 4, beneficiary_status: 'Skipped' }),
        resRow({ resident_id: 5, beneficiary_status: 'Not Eligible' }),
        resRow({ resident_id: 6, beneficiary_status: null }),
      ],
    });

    const { res } = await run(getServiceDetails, { params: ID });
    const data = res.json.mock.calls[0][0].data;

    expect(data.rawId).toBe(5);
    expect(data.summary).toEqual({
      totalResidents: 6,
      totalBeneficiaries: 2,
      notYetServed: 4,
      pending: 1,
      skipped: 1,
      notEligible: 1,
      completionRate: 33,
    });
  });

  it('shows a 0% completion rate when there are no residents', async () => {
    setupDb({ checklist: [] });

    const { res } = await run(getServiceDetails, { params: ID });

    expect(res.json.mock.calls[0][0].data.summary).toMatchObject({
      totalResidents: 0,
      completionRate: 0,
    });
  });

  it('counts only seniors for a Senior Citizens service, including age 60', async () => {
    setupDb({
      service: serviceRow({ target_scope: 'Senior Citizens' }),
      checklist: [
        resRow({ resident_id: 1, age: 70 }),
        resRow({ resident_id: 2, age: 60 }),
        resRow({ resident_id: 3, age: 59 }),
        resRow({ resident_id: 4, age: 30 }),
      ],
    });

    const { res } = await run(getServiceDetails, { params: ID });

    expect(res.json.mock.calls[0][0].data.summary.totalResidents).toBe(2);
  });

  it('passes a 404 error to next when the service does not exist', async () => {
    setupDb({ service: null });

    const { next } = await run(getServiceDetails, { params: ID });

    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });
});

describe('service access for barangay staff', () => {
  const canOpen = async (user, row) => {
    setupDb({ service: row });
    const { res, next } = await run(getServiceDetails, { user, params: ID });
    return { opened: res.json.mock.calls.length === 1, next };
  };

  it('lets an admin open a service in any barangay', async () => {
    const { opened } = await canOpen(admin, serviceRow({ barangay: 'Other' }));
    expect(opened).toBe(true);
  });

  it('lets staff open a service in their barangay with no office', async () => {
    const { opened } = await canOpen(staff(), serviceRow({ office_id: null }));
    expect(opened).toBe(true);
  });

  it('lets staff open a service in their own office', async () => {
    const { opened } = await canOpen(staff(), serviceRow({ office_id: 2 }));
    expect(opened).toBe(true);
  });

  it('blocks staff from a service in another barangay', async () => {
    const { opened, next } = await canOpen(
      staff(),
      serviceRow({ barangay: 'Other' }),
    );

    expect(opened).toBe(false);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(next.mock.calls[0][0].message).toBe(
      'You do not have permission to manage this service',
    );
  });

  it('blocks staff from another office without the permission', async () => {
    const { opened, next } = await canOpen(staff(), serviceRow({ office_id: 3 }));

    expect(opened).toBe(false);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('lets staff open another office with the permission', async () => {
    const { opened } = await canOpen(
      staff({ permissions: ['services:view_all_offices'] }),
      serviceRow({ office_id: 3 }),
    );
    expect(opened).toBe(true);
  });
});

describe('getServiceChecklist', () => {
  it('looks up residents of the service barangay with safe parameters', async () => {
    await run(getServiceChecklist, { params: ID });

    const [sql, params] = callFor('FROM resident_accounts ra');
    expect(sql).toContain('ra.barangay = ?');
    expect(params).toEqual([5, 'Balanti']);
  });

  it('adds search, purok, and gender to the query', async () => {
    await run(getServiceChecklist, {
      params: ID,
      query: { search: 'ju', purok: 'Purok 1', gender: 'Male' },
    });

    expect(callFor('FROM resident_accounts ra')[1]).toEqual([
      5,
      'Balanti',
      '%ju%',
      '%ju%',
      '%ju%',
      '%ju%',
      'Purok 1',
      'Male',
    ]);
  });

  it('shows residents with no record as Not Served', async () => {
    setupDb({ checklist: [resRow({ beneficiary_status: null })] });

    const { res } = await run(getServiceChecklist, { params: ID });

    expect(res.json.mock.calls[0][0].data[0]).toMatchObject({
      residentId: 12,
      residentCode: 'RES-0012',
      name: 'Juan Cruz',
      beneficiaryStatus: 'Not Served',
      gender: 'Male',
    });
  });

  it('falls back to the email when there is no contact number', async () => {
    setupDb({ checklist: [resRow({ contact_number: null })] });

    const { res } = await run(getServiceChecklist, { params: ID });

    expect(res.json.mock.calls[0][0].data[0].contactNumber).toBe('juan@example.com');
  });

  describe('filters', () => {
    const ids = (res) => res.json.mock.calls[0][0].data.map((r) => r.residentId);

    it('filters by beneficiary status', async () => {
      setupDb({
        checklist: [
          resRow({ resident_id: 1, beneficiary_status: 'Pending' }),
          resRow({ resident_id: 2, beneficiary_status: 'Served' }),
          resRow({ resident_id: 3, beneficiary_status: null }),
        ],
      });

      const pending = await run(getServiceChecklist, {
        params: ID,
        query: { status: 'Pending' },
      });
      expect(ids(pending.res)).toEqual([1]);
    });

    it('can filter for residents who are Not Served', async () => {
      setupDb({
        checklist: [
          resRow({ resident_id: 1, beneficiary_status: 'Served' }),
          resRow({ resident_id: 2, beneficiary_status: null }),
        ],
      });

      const { res } = await run(getServiceChecklist, {
        params: ID,
        query: { status: 'Not Served' },
      });
      expect(ids(res)).toEqual([2]);
    });

    it('filters by age group at the boundaries', async () => {
      setupDb({
        checklist: [
          resRow({ resident_id: 1, age: 20 }),
          resRow({ resident_id: 2, age: 24 }),
          resRow({ resident_id: 3, age: 25 }),
          resRow({ resident_id: 4, age: 59 }),
          resRow({ resident_id: 5, age: 60 }),
        ],
      });

      const youth = await run(getServiceChecklist, {
        params: ID,
        query: { ageGroup: 'Youth' },
      });
      expect(ids(youth.res)).toEqual([1, 2]);

      const adult = await run(getServiceChecklist, {
        params: ID,
        query: { ageGroup: 'Adult' },
      });
      expect(ids(adult.res)).toEqual([3, 4]);

      const senior = await run(getServiceChecklist, {
        params: ID,
        query: { ageGroup: 'Senior' },
      });
      expect(ids(senior.res)).toEqual([5]);
    });
  });
});

describe('served and not-yet-served lists', () => {
  const people = () => [
    resRow({ resident_id: 1, beneficiary_status: 'Served' }),
    resRow({ resident_id: 2, beneficiary_status: 'Pending' }),
    resRow({ resident_id: 3, beneficiary_status: null }),
  ];

  it('getServedBeneficiaries returns only served residents', async () => {
    setupDb({ checklist: people() });

    const { res } = await run(getServedBeneficiaries, { params: ID });

    expect(res.json.mock.calls[0][0].data.map((r) => r.residentId)).toEqual([1]);
  });

  it('getNotYetServedResidents returns everyone except served residents', async () => {
    setupDb({ checklist: people() });

    const { res } = await run(getNotYetServedResidents, { params: ID });

    expect(res.json.mock.calls[0][0].data.map((r) => r.residentId)).toEqual([2, 3]);
  });
});

// ---------- CSV exports (FR12) ----------

describe('CSV exports', () => {
  const SUMMARY_HEADER =
    'Service ID,Service Name,Category,Barangay,Office,Target Scope,Start Date,End Date,Target Residents,Served Count,Not Yet Served Count,Completion Rate,Status,Remarks';
  const RESIDENT_HEADER =
    'Service Name,Service ID,Category,Barangay,Resident ID,Resident Name,Age,Gender,Purok/Sitio,Contact Number,Beneficiary Status,Date Served,Processed By,Remarks';

  const body = (res) => res.send.mock.calls[0][0];
  const header = (res, name) =>
    res.setHeader.mock.calls.find(([key]) => key === name)?.[1];

  describe('exportServicesSummaryCsv', () => {
    it('sends a CSV download with the right headers', async () => {
      setupDb({ list: [serviceRow()] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(header(res, 'Content-Type')).toBe('text/csv; charset=utf-8');
      expect(header(res, 'Content-Disposition')).toMatch(
        /^attachment; filename="community-services-summary-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
    });

    it('starts with a byte order mark and the column names', async () => {
      setupDb({ list: [serviceRow()] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(body(res).startsWith(`\uFEFF${SUMMARY_HEADER}\n`)).toBe(true);
    });

    it('writes one row per service', async () => {
      setupDb({ list: [serviceRow()] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(body(res)).toContain(
        'SRV-005,Free Medical Checkup,Health,Balanti,,All Residents,,,100,25,75,25%,Active,',
      );
    });

    it('sends only the header when there are no services', async () => {
      setupDb({ list: [] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(body(res)).toBe(`\uFEFF${SUMMARY_HEADER}`);
    });

    it('wraps cells with commas and quotes, and doubles the quotes', async () => {
      setupDb({ list: [serviceRow({ name: 'Feeding, "Special" Program' })] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(body(res)).toContain('"Feeding, ""Special"" Program"');
    });

    it('wraps cells that contain a new line', async () => {
      setupDb({ list: [serviceRow({ remarks: 'Line1\nLine2' })] });

      const { res } = await run(exportServicesSummaryCsv, {});

      expect(body(res)).toContain('"Line1\nLine2"');
    });

    it('records an audit entry', async () => {
      setupDb({ list: [serviceRow()] });

      await run(exportServicesSummaryCsv, { query: { status: 'Active' } });

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'services.export_summary',
          details: { status: 'Active' },
        }),
      );
    });
  });

  describe('exportServiceChecklistCsv', () => {
    const served = resRow({
      resident_id: 12,
      beneficiary_status: 'Served',
      served_at: '2026-02-03T00:00:00.000Z',
      processed_by_name: 'Ana',
    });

    it('writes the column names and one row per resident', async () => {
      setupDb({ checklist: [served] });

      const { res } = await run(exportServiceChecklistCsv, { params: ID });

      expect(body(res).startsWith(`\uFEFF${RESIDENT_HEADER}\n`)).toBe(true);
      expect(body(res)).toContain(
        'Free Medical Checkup,SRV-005,Health,Balanti,RES-0012,Juan Cruz,30,Male,Purok 1,09171234567,Served,2026-02-03,Ana,',
      );
    });

    it('builds a safe file name from the service name', async () => {
      setupDb({ service: serviceRow({ name: 'Libreng Gamot!! (2026)' }) });

      const { res } = await run(exportServiceChecklistCsv, { params: ID });

      expect(header(res, 'Content-Disposition')).toMatch(
        /^attachment; filename="community-libreng-gamot-2026-checklist-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
    });

    it('records an audit entry', async () => {
      setupDb({ checklist: [served] });

      await run(exportServiceChecklistCsv, { params: ID });

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'services.export_checklist',
          entityId: 5,
        }),
      );
    });

    it('passes a 404 error to next and sends no file', async () => {
      setupDb({ service: null });

      const { res, next } = await run(exportServiceChecklistCsv, { params: ID });

      expect(next.mock.calls[0][0].statusCode).toBe(404);
      expect(res.send).not.toHaveBeenCalled();
    });

    it('blocks staff from another barangay with 403', async () => {
      setupDb({ service: serviceRow({ barangay: 'Other' }) });

      const { res, next } = await run(exportServiceChecklistCsv, {
        user: staff(),
        params: ID,
      });

      expect(next.mock.calls[0][0].statusCode).toBe(403);
      expect(res.send).not.toHaveBeenCalled();
    });
  });

  describe('beneficiary exports', () => {
    const people = () => [
      resRow({ resident_id: 1, first_name: 'Juan', last_name: 'Cruz', beneficiary_status: 'Served' }),
      resRow({ resident_id: 2, first_name: 'Maria', last_name: 'Santos', beneficiary_status: 'Pending' }),
    ];

    it('exportServiceBeneficiariesCsv includes only served residents', async () => {
      setupDb({ checklist: people() });

      const { res } = await run(exportServiceBeneficiariesCsv, { params: ID });

      expect(body(res)).toContain('Juan Cruz');
      expect(body(res)).not.toContain('Maria Santos');
      expect(header(res, 'Content-Disposition')).toContain('-beneficiaries-');
    });

    it('exportServiceBeneficiariesCsv cannot be switched to another status by the URL', async () => {
      setupDb({ checklist: people() });

      const { res } = await run(exportServiceBeneficiariesCsv, {
        params: ID,
        query: { status: 'Pending' },
      });

      expect(body(res)).toContain('Juan Cruz');
      expect(body(res)).not.toContain('Maria Santos');
    });

    it('exportServiceNotYetServedCsv leaves out served residents', async () => {
      setupDb({ checklist: people() });

      const { res } = await run(exportServiceNotYetServedCsv, { params: ID });

      expect(body(res)).toContain('Maria Santos');
      expect(body(res)).not.toContain('Juan Cruz');
      expect(header(res, 'Content-Disposition')).toContain('-not-yet-served-');
    });
  });
});