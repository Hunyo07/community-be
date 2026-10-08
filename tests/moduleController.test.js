import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import path from 'node:path';

// Replace everything the controller talks to with fakes before it loads.
vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn() },
}));
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn(), query: vi.fn() },
}));
vi.mock('../src/realtime/socket.js', () => ({
  emitRealtimeEvent: vi.fn(),
}));
vi.mock('../src/utils/auditLogger.js', () => ({
  logAudit: vi.fn(),
}));
vi.mock('../src/utils/password.js', () => ({
  hashPassword: vi.fn(),
}));
vi.mock('../src/utils/settings.js', () => ({
  isSettingEnabled: vi.fn(),
}));

import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { emitRealtimeEvent } from '../src/realtime/socket.js';
import { logAudit } from '../src/utils/auditLogger.js';
import { hashPassword } from '../src/utils/password.js';
import { isSettingEnabled } from '../src/utils/settings.js';
import { PASSWORD_POLICY_MESSAGE } from '../src/utils/passwordPolicy.js';
import { PERMISSIONS, ROLES, rolePermissions } from '../src/rbac/roles.js';
import {
  listModule,
  createModule,
  updateModule,
  updateRequestStatus,
  updateRequestDetails,
  markNotificationRead,
  getNotificationSummary,
  markAllNotificationsRead,
  deleteAnnouncement,
  getAnnouncementPoster,
  listStaff,
  createStaff,
  updateStaff,
} from '../src/controllers/moduleController.js';

// Freeze "today" at June 15, 2026 so dates are the same on any day.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------- helpers ----------

const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendFile = vi.fn().mockReturnValue(res);
  return res;
};

const admin = {
  id: 1,
  name: 'Ana Admin',
  role: 'admin',
  accountType: 'staff',
  permissions: [],
};

const staff = (overrides = {}) => ({
  id: 2,
  name: 'Sam Staff',
  role: 'barangay_staff',
  accountType: 'staff',
  barangay: 'Balanti',
  permissions: [],
  ...overrides,
});

const resident = (overrides = {}) => ({
  id: 12,
  name: 'Juan Cruz',
  role: 'resident',
  accountType: 'resident',
  barangay: 'Balanti',
  permissions: [],
  ...overrides,
});

// A request row as the status workflow reads it.
const requestRow = (overrides = {}) => ({
  id: 20,
  residentId: 12,
  title: 'Barangay Clearance',
  status: 'Submitted',
  barangay: 'Balanti',
  ...overrides,
});

// A request row as the edit-details check reads it.
const detailsRow = (overrides = {}) => ({
  id: 20,
  residentId: 12,
  status: 'Submitted',
  documentTypeName: 'Barangay Clearance',
  ...overrides,
});

const posterRow = (overrides = {}) => ({
  id: 4,
  title: 'Typhoon advisory',
  posterImage: 'uploads/poster.jpg',
  audience: 'All',
  barangay: null,
  status: 'Published',
  expiresAt: null,
  ...overrides,
});

// Sets up a fake database that answers by recognizing the SQL text.
const setupDb = (overrides = {}) => {
  const state = {
    docType: { id: 3, name: 'Barangay Clearance', status: 'Active' },
    statusRequest: requestRow(),
    detailsRequest: detailsRow(),
    staffRow: { id: 3 },
    poster: null,
    userBarangay: null,
    residents: [],
    rows: [],
    insertId: 20,
    affectedRows: 1,
    statusAffectedRows: 1,
    insertError: null,
    updateError: null,
    ...overrides,
  };

  pool.execute.mockImplementation(async (rawSql) => {
    const sql = rawSql.trim();

    if (sql.includes('FROM document_types WHERE id = ?')) {
      return [state.docType ? [state.docType] : []];
    }
    if (sql.includes('dt.name AS documentTypeName') && sql.includes('WHERE sr.id = ?')) {
      return [state.detailsRequest ? [state.detailsRequest] : []];
    }
    if (sql.includes('WHERE sr.id = ?')) {
      return [state.statusRequest ? [state.statusRequest] : []];
    }
    if (
      sql.startsWith('SELECT barangay FROM resident_accounts') ||
      sql.startsWith('SELECT barangay FROM staff_accounts')
    ) {
      return [state.userBarangay ? [{ barangay: state.userBarangay }] : []];
    }
    if (sql.startsWith('SELECT id FROM resident_accounts WHERE')) {
      return [state.residents];
    }
    if (sql.startsWith('SELECT id FROM staff_accounts WHERE id = ?')) {
      return [state.staffRow ? [state.staffRow] : []];
    }
    if (sql.startsWith('SELECT id, title, poster_image')) {
      return [state.poster ? [state.poster] : []];
    }
    if (sql.startsWith('UPDATE service_requests SET status')) {
      return [{ affectedRows: state.statusAffectedRows }];
    }
    if (sql.startsWith('INSERT')) {
      if (state.insertError) throw state.insertError;
      return [{ insertId: state.insertId }];
    }
    if (sql.startsWith('UPDATE') || sql.startsWith('DELETE')) {
      if (state.updateError) throw state.updateError;
      return [{ affectedRows: state.affectedRows }];
    }
    return [state.rows];
  });

  pool.query.mockResolvedValue([state.rows]);
};

const callFor = (text) =>
  pool.execute.mock.calls.find(([sql]) => sql.includes(text));

const run = async (handler, req = {}) => {
  const res = createRes();
  const next = vi.fn();
  await handler(
    { user: admin, params: {}, body: {}, query: {}, ...req },
    res,
    next,
  );
  return { res, next };
};

const dataOf = (res) => res.json.mock.calls[0][0].data;

const duplicateError = () =>
  Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

beforeEach(() => {
  pool.execute.mockReset();
  pool.query.mockReset();
  logAudit.mockReset();
  emitRealtimeEvent.mockReset();
  hashPassword.mockReset();
  hashPassword.mockReturnValue('hashed');
  isSettingEnabled.mockReset();
  isSettingEnabled.mockResolvedValue(true);
  fs.existsSync.mockReset();
  setupDb();
});

// =====================================================
// DOCUMENT REQUESTS: SUBMITTING (FR7)
// =====================================================

describe('document requests: submitting (FR7)', () => {
  const makeBody = (extra = {}) => ({
    documentTypeId: '3',
    description: 'For job application',
    ...extra,
  });
  const submit = (body = makeBody(), user = resident()) =>
    run(createModule('requests'), { user, body });
  const insertCall = () => callFor('INSERT INTO service_requests');

  it('creates the request and responds with 201', async () => {
    const { res, next } = await submit();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(dataOf(res)).toMatchObject({
      id: 20,
      documentTypeId: 3,
      title: 'Barangay Clearance',
      status: 'Submitted',
      description: 'For job application',
    });
  });

  it('saves the request for the signed-in resident with a safe query', async () => {
    await submit();

    const [sql, params] = insertCall();
    expect(sql).not.toContain('job application');
    expect(params).toEqual([
      12,
      null,
      3,
      'Barangay Clearance',
      'For job application',
      'Submitted',
      'Normal',
    ]);
  });

  it('looks up the document type with a safe query', async () => {
    await submit();
    expect(callFor('FROM document_types WHERE id = ?')[1]).toEqual([3]);
  });

  it('uses the document type name as the title and ignores a title that was sent', async () => {
    await submit(makeBody({ title: 'Hacked title' }));
    expect(insertCall()[1][3]).toBe('Barangay Clearance');
  });

  it('always saves the status as Submitted', async () => {
    await submit(makeBody({ status: 'Approved' }));
    expect(insertCall()[1][5]).toBe('Submitted');
  });

  it('uses an empty description when none is sent', async () => {
    await submit({ documentTypeId: '3' });
    expect(insertCall()[1][4]).toBe('');
  });

  it('lets staff file a request on behalf of a resident', async () => {
    await submit(makeBody({ residentId: 12 }), staff());
    expect(insertCall()[1][0]).toBe(12);
  });

  it('saves no resident when staff give none', async () => {
    await submit(makeBody(), staff());
    expect(insertCall()[1][0]).toBeNull();
  });

  it('records an audit entry', async () => {
    await submit();

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'requests.create',
        entityType: 'service_requests',
        entityId: 20,
      }),
    );
  });

  it('sends realtime events', async () => {
    await submit();

    expect(emitRealtimeEvent).toHaveBeenCalledWith('requests:changed', {
      action: 'created',
      id: 20,
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'requests-created',
    });
  });

  it('notifies the resident that the request was submitted', async () => {
    await submit();

    const [sql, params] = callFor('INSERT INTO notifications');
    expect(sql).toContain('?');
    expect(params).toEqual([
      12,
      'Document request submitted',
      'Your Barangay Clearance request was submitted and is waiting for review.',
    ]);
    expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
      action: 'created',
      userId: 12,
      userRole: 'resident',
    });
  });

  it('skips the notification when the setting is turned off', async () => {
    isSettingEnabled.mockResolvedValue(false);

    const { res } = await submit();

    expect(isSettingEnabled).toHaveBeenCalledWith('request_auto_notifications', true);
    expect(callFor('INSERT INTO notifications')).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('sends no notification when staff file the request', async () => {
    await submit(makeBody(), staff());

    expect(isSettingEnabled).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO notifications')).toBeUndefined();
  });

  it('passes database errors to next and sends no response', async () => {
    setupDb({ insertError: new Error('Database is down') });

    const { res, next } = await submit();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('document requests: rejected submissions', () => {
  const submit = (body) =>
    run(createModule('requests'), { user: resident(), body });

  const expectRejected = (res, next, message) => {
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message });
    expect(next).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO service_requests')).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  };

  it.each([undefined, '', 0, '0', 'abc'])(
    'requires a document type (got %s)',
    async (documentTypeId) => {
      const { res, next } = await submit({ documentTypeId, description: 'x' });

      expectRejected(res, next, 'Document type is required');
      expect(pool.execute).not.toHaveBeenCalled();
    },
  );

  it('rejects a document type that does not exist', async () => {
    setupDb({ docType: null });

    const { res, next } = await submit({ documentTypeId: '99' });

    expectRejected(res, next, 'Selected document type is not available');
  });

  it('rejects a document type that was deactivated', async () => {
    setupDb({ docType: { id: 3, name: 'Barangay Clearance', status: 'Inactive' } });

    const { res, next } = await submit({ documentTypeId: '3' });

    expectRejected(res, next, 'Selected document type is not available');
  });
});

describe('document requests: the Others type', () => {
  beforeEach(() => {
    setupDb({ docType: { id: 9, name: 'Others', status: 'Active' } });
  });

  const submit = (body) =>
    run(createModule('requests'), { user: resident(), body });

  it('uses the document the resident named as the title', async () => {
    await submit({ documentTypeId: '9', title: 'Cedula' });

    expect(callFor('INSERT INTO service_requests')[1][2]).toBe(9);
    expect(callFor('INSERT INTO service_requests')[1][3]).toBe('Cedula');
  });

  it('trims spaces around the named document', async () => {
    await submit({ documentTypeId: '9', title: '  Cedula  ' });
    expect(callFor('INSERT INTO service_requests')[1][3]).toBe('Cedula');
  });

  it('mentions the named document in the notification', async () => {
    await submit({ documentTypeId: '9', title: 'Cedula' });

    expect(callFor('INSERT INTO notifications')[1][2]).toBe(
      'Your Cedula request was submitted and is waiting for review.',
    );
  });

  it.each([undefined, '', '   ', 'Others', 'others', 'OTHERS'])(
    'requires the resident to name the document (got %s)',
    async (title) => {
      const { res, next } = await submit({ documentTypeId: '9', title });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Specify the document for an Others request',
      });
      expect(next).not.toHaveBeenCalled();
      expect(callFor('INSERT INTO service_requests')).toBeUndefined();
    },
  );
});

// =====================================================
// DOCUMENT REQUESTS: VIEWING (FR9)
// =====================================================

describe('document requests: who sees which requests', () => {
  const listCall = () => callFor('FROM service_requests sr');

  it('shows every request to an admin', async () => {
    await run(listModule('requests'), { user: admin });

    expect(listCall()[0]).not.toContain('WHERE');
    expect(listCall()[1]).toEqual([]);
  });

  it('shows a resident only their own requests', async () => {
    await run(listModule('requests'), { user: resident() });

    expect(listCall()[0]).toContain('WHERE sr.resident_id = ?');
    expect(listCall()[1]).toEqual([12]);
  });

  it('limits staff to residents in their barangay', async () => {
    await run(listModule('requests'), { user: staff() });

    expect(listCall()[0]).toContain('ra.barangay = ?');
    expect(listCall()[1]).toEqual(['Balanti']);
  });

  it('shows staff with no barangay nothing instead of everything', async () => {
    await run(listModule('requests'), { user: staff({ barangay: undefined }) });
    expect(listCall()[1]).toEqual(['']);
  });

  it('sorts newest first', async () => {
    await run(listModule('requests'), { user: admin });
    expect(listCall()[0]).toContain('ORDER BY sr.created_at DESC');
  });

  it('returns the rows from the database', async () => {
    setupDb({ rows: [{ id: 1 }, { id: 2 }] });

    const { res } = await run(listModule('requests'), { user: admin });

    expect(dataOf(res)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(listModule('requests'), { user: admin });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

// =====================================================
// DOCUMENT REQUESTS: STATUS WORKFLOW (FR8, FR10)
// =====================================================

describe('document requests: status workflow (FR8, FR10)', () => {
  const ID = { id: '20' };
  const change = (status, req = {}) =>
    run(updateRequestStatus, { params: ID, body: { status }, ...req });
  const statusUpdate = () => callFor('UPDATE service_requests SET status');

  it.each([
    'Submitted',
    'Under Review',
    'Approved',
    'Rejected',
    'Processing',
    'Completed',
    'Cancelled',
  ])('lets an admin set the status to %s', async (status) => {
    const { res, next } = await change(status);

    expect(next).not.toHaveBeenCalled();
    expect(statusUpdate()[0]).toContain('?');
    expect(statusUpdate()[1]).toEqual([status, '20']);
    expect(dataOf(res)).toEqual({ id: '20', status });
  });

  it('lets a request be marked Claimed once it is ready to claim', async () => {
    setupDb({ statusRequest: requestRow({ status: 'Completed' }) });

    const { res } = await change('Claimed');

    expect(statusUpdate()[1]).toEqual(['Claimed', '20']);
    expect(dataOf(res)).toEqual({ id: '20', status: 'Claimed' });
  });

  it('will not mark a request Claimed before it is ready to claim', async () => {
    setupDb({ statusRequest: requestRow({ status: 'Approved' }) });

    const { res } = await change('Claimed');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Only ready-to-claim requests can be marked as claimed',
    });
    expect(statusUpdate()).toBeUndefined();
  });

  it.each(['Done', 'approved', '', undefined])(
    'rejects the status %s with 400',
    async (status) => {
      const { res } = await change(status);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid request status' });
      expect(pool.execute).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the request does not exist', async () => {
    setupDb({ statusRequest: null });

    const { res } = await change('Approved');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Request not found' });
    expect(statusUpdate()).toBeUndefined();
  });

  it('returns 404 and tells no one when the update affects no rows', async () => {
    setupDb({ statusAffectedRows: 0 });

    const { res } = await change('Approved');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(callFor('INSERT INTO notifications')).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('lets an admin update a request from any barangay', async () => {
    setupDb({ statusRequest: requestRow({ barangay: 'Other' }) });

    await change('Approved');

    expect(statusUpdate()).toBeDefined();
  });

  it('lets staff update a request from their own barangay', async () => {
    await change('Approved', { user: staff() });
    expect(statusUpdate()[1]).toEqual(['Approved', '20']);
  });

  it('blocks staff from updating a request in another barangay', async () => {
    setupDb({ statusRequest: requestRow({ barangay: 'Other' }) });

    const { res } = await change('Approved', { user: staff() });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You do not have permission to update this request',
    });
    expect(statusUpdate()).toBeUndefined();
    expect(callFor('INSERT INTO notifications')).toBeUndefined();
  });

  describe('residents', () => {
    it('lets a resident cancel their own submitted request', async () => {
      const { res } = await change('Cancelled', { user: resident() });

      expect(statusUpdate()[1]).toEqual(['Cancelled', '20']);
      expect(dataOf(res)).toEqual({ id: '20', status: 'Cancelled' });
    });

    it.each(['Approved', 'Completed', 'Claimed', 'Submitted'])(
      'blocks a resident from setting the status to %s',
      async (status) => {
        const { res } = await change(status, { user: resident() });

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Residents can submit requests but cannot update request status',
        });
        expect(pool.execute).not.toHaveBeenCalled();
      },
    );

    it('blocks a resident from cancelling someone else\'s request', async () => {
      setupDb({ statusRequest: requestRow({ residentId: 99 }) });

      const { res } = await change('Cancelled', { user: resident() });

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: 'You can only update your own requests',
      });
      expect(statusUpdate()).toBeUndefined();
    });

    it('blocks a resident from cancelling a request that is already under review', async () => {
      setupDb({ statusRequest: requestRow({ status: 'Under Review' }) });

      const { res } = await change('Cancelled', { user: resident() });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Only submitted requests can be cancelled by residents',
      });
      expect(statusUpdate()).toBeUndefined();
    });
  });

  describe('telling the resident', () => {
    it.each([
      ['Under Review', 'Your Barangay Clearance request is now Under Review.'],
      ['Approved', 'Your Barangay Clearance request is now Approved.'],
      ['Rejected', 'Your Barangay Clearance request is now Rejected.'],
      ['Processing', 'Your Barangay Clearance request is now Processing.'],
      [
        'Completed',
        'Your Barangay Clearance request is ready. Please claim your document at your barangay office.',
      ],
    ])('sends the right notification for %s', async (status, message) => {
      await change(status);

      const [sql, params] = callFor('INSERT INTO notifications');
      expect(sql).toContain('?');
      expect(params).toEqual([12, 'Document request status updated', message]);
    });

    it('sends the right notification when the request is claimed', async () => {
      setupDb({ statusRequest: requestRow({ status: 'Completed' }) });

      await change('Claimed');

      expect(callFor('INSERT INTO notifications')[1][2]).toBe(
        'Your Barangay Clearance request has been marked as claimed.',
      );
    });

    it('sends a realtime notification event', async () => {
      await change('Approved');

      expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
        action: 'created',
        userId: 12,
        userRole: 'resident',
      });
    });

    it('skips the notification when the setting is turned off', async () => {
      isSettingEnabled.mockResolvedValue(false);

      const { res } = await change('Approved');

      expect(isSettingEnabled).toHaveBeenCalledWith('request_auto_notifications', true);
      expect(callFor('INSERT INTO notifications')).toBeUndefined();
      expect(statusUpdate()).toBeDefined();
      expect(res.json).toHaveBeenCalledTimes(1);
    });

    it('skips the notification when the request has no resident', async () => {
      setupDb({ statusRequest: requestRow({ residentId: null }) });

      const { res } = await change('Approved');

      expect(isSettingEnabled).not.toHaveBeenCalled();
      expect(callFor('INSERT INTO notifications')).toBeUndefined();
      expect(res.json).toHaveBeenCalledTimes(1);
    });
  });

  it('records an audit entry and sends realtime events', async () => {
    await change('Approved');

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'requests.status_update',
        entityType: 'service_requests',
        entityId: '20',
        details: { status: 'Approved' },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('requests:changed', {
      action: 'status-updated',
      id: '20',
      status: 'Approved',
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'request-status-updated',
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await change('Approved');

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

// =====================================================
// DOCUMENT REQUESTS: EDITING DETAILS
// =====================================================

describe('document requests: editing details', () => {
  const ID = { id: '20' };
  const edit = (body, req = {}) =>
    run(updateRequestDetails, { params: ID, body, ...req });
  const detailsUpdate = () => callFor('SET title = ?, description = ?');

  it('saves the title and description with a safe query', async () => {
    const { res, next } = await edit({
      title: 'Barangay Residency',
      description: 'Updated note',
    });

    expect(next).not.toHaveBeenCalled();
    expect(detailsUpdate()[0]).toContain('WHERE id = ?');
    expect(detailsUpdate()[1]).toEqual(['Barangay Residency', 'Updated note', '20']);
    expect(dataOf(res)).toEqual({
      id: '20',
      title: 'Barangay Residency',
      description: 'Updated note',
    });
  });

  it('trims spaces around the title', async () => {
    await edit({ title: '  Barangay Residency  ' });
    expect(detailsUpdate()[1][0]).toBe('Barangay Residency');
  });

  it('uses an empty description when none is sent', async () => {
    await edit({ title: 'Barangay Residency' });
    expect(detailsUpdate()[1][1]).toBe('');
  });

  it.each([undefined, '', '   '])(
    'requires a title (got %s)',
    async (title) => {
      const { res } = await edit({ title });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Request title is required' });
      expect(detailsUpdate()).toBeUndefined();
    },
  );

  it('returns 404 when the request does not exist', async () => {
    setupDb({ detailsRequest: null });

    const { res } = await edit({ title: 'Anything' });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Request not found' });
    expect(detailsUpdate()).toBeUndefined();
  });

  describe('the Others type', () => {
    beforeEach(() => {
      setupDb({ detailsRequest: detailsRow({ documentTypeName: 'Others' }) });
    });

    it('saves the document the resident named', async () => {
      await edit({ title: '  Cedula  ' });
      expect(detailsUpdate()[1][0]).toBe('Cedula');
    });

    it.each([undefined, '', '   ', 'Others', 'others'])(
      'requires the document to be named (got %s)',
      async (title) => {
        const { res } = await edit({ title });

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
          message: 'Specify the document for an Others request',
        });
        expect(detailsUpdate()).toBeUndefined();
      },
    );
  });

  describe('residents', () => {
    it('lets a resident edit their own submitted request', async () => {
      await edit({ title: 'Barangay Residency' }, { user: resident() });
      expect(detailsUpdate()).toBeDefined();
    });

    it('blocks a resident from editing someone else\'s request', async () => {
      setupDb({ detailsRequest: detailsRow({ residentId: 99 }) });

      const { res } = await edit({ title: 'Anything' }, { user: resident() });

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: 'You can only edit your own requests',
      });
      expect(detailsUpdate()).toBeUndefined();
    });

    it('blocks a resident from editing a request that is no longer submitted', async () => {
      setupDb({ detailsRequest: detailsRow({ status: 'Approved' }) });

      const { res } = await edit({ title: 'Anything' }, { user: resident() });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Only submitted requests can be edited',
      });
      expect(detailsUpdate()).toBeUndefined();
    });
  });

  it('records an audit entry and sends realtime events', async () => {
    await edit({ title: 'Barangay Residency', description: 'Note' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'requests.update',
        entityType: 'service_requests',
        entityId: '20',
        details: { title: 'Barangay Residency', description: 'Note' },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('requests:changed', {
      action: 'updated',
      id: '20',
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'request-updated',
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { next } = await edit({ title: 'Anything' });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
  });
});

// =====================================================
// SHARED MODULES: BARANGAYS, OFFICES, CATEGORIES, DOCUMENT TYPES
// =====================================================

describe('shared modules: listing', () => {
  it.each([
    ['barangays', 'FROM barangays'],
    ['offices', 'FROM offices'],
    ['serviceCategories', 'FROM service_categories'],
    ['documentTypes', 'FROM document_types'],
    ['auditLogs', 'FROM audit_logs'],
  ])('lists %s', async (moduleName, fromText) => {
    setupDb({ rows: [{ id: 1 }, { id: 2 }] });

    const { res } = await run(listModule(moduleName));

    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute.mock.calls[0][0]).toContain(fromText);
    expect(pool.execute.mock.calls[0][1]).toEqual([]);
    expect(dataOf(res)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('limits the audit log list to the latest 100 entries, newest first', async () => {
    await run(listModule('auditLogs'));

    const sql = pool.execute.mock.calls[0][0];
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT 100');
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(listModule('barangays'));

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('shared modules: creating', () => {
  it.each([
    [
      'barangays',
      'barangays',
      'barangays:changed',
      { name: 'Balanti', captain: 'Maria', contact: '0917' },
      ['Balanti', 'Maria', '0917', 'Active'],
      'INSERT INTO barangays',
    ],
    [
      'offices',
      'offices',
      'offices:changed',
      { name: 'Health Office', barangay: 'Balanti', description: 'Health programs' },
      ['Health Office', 'Balanti', 'Health programs', 'Active'],
      'INSERT INTO offices',
    ],
    [
      'serviceCategories',
      'service_categories',
      'service-categories:changed',
      { name: 'Health', description: 'Health services' },
      ['Health', 'Health services', 'Active'],
      'INSERT INTO service_categories',
    ],
    [
      'documentTypes',
      'document_types',
      'document-types:changed',
      { name: 'Barangay Clearance', status: 'Inactive' },
      ['Barangay Clearance', '', 'Inactive'],
      'INSERT INTO document_types',
    ],
  ])(
    'creates a record in %s',
    async (moduleName, table, realtime, body, expectedParams, insertText) => {
      const { res, next } = await run(createModule(moduleName), { body: { ...body } });

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(dataOf(res)).toEqual({ id: 20, ...body });

      const [sql, params] = callFor(insertText);
      expect(sql).toContain('?');
      expect(params).toEqual(expectedParams);

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: `${moduleName}.create`,
          entityType: table,
          entityId: 20,
        }),
      );
      expect(emitRealtimeEvent).toHaveBeenCalledWith(realtime, {
        action: 'created',
        id: 20,
      });
      expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
        reason: `${moduleName}-created`,
      });
    },
  );

  it('fills in empty defaults for optional fields', async () => {
    await run(createModule('barangays'), { body: { name: 'Balanti' } });
    expect(callFor('INSERT INTO barangays')[1]).toEqual(['Balanti', '', '', 'Active']);
  });

  it('keeps a value out of the SQL text', async () => {
    await run(createModule('barangays'), {
      body: { name: "x'; DROP TABLE barangays;--" },
    });

    const [sql, params] = callFor('INSERT INTO barangays');
    expect(sql).not.toContain('DROP TABLE');
    expect(params[0]).toBe("x'; DROP TABLE barangays;--");
  });

  it('creates a notification with the resident role by default', async () => {
    await run(createModule('notifications'), { body: { title: 'Hello' } });
    expect(callFor('INSERT INTO notifications')[1]).toEqual([null, 'resident', 'Hello', '']);
  });

  it('passes database errors to next and sends no response', async () => {
    setupDb({ insertError: new Error('Database is down') });

    const { res, next } = await run(createModule('barangays'), {
      body: { name: 'Balanti' },
    });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('cannot create audit log entries through the API (FR14)', async () => {
    const { res, next } = await run(createModule('auditLogs'), {
      body: { action: 'fake.entry' },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(pool.execute).not.toHaveBeenCalled();
  });
});

describe('shared modules: updating', () => {
  const ID = { id: '7' };

  it('updates a record with a safe query', async () => {
    const body = { name: 'Balanti', captain: 'Maria', contact: '0917', status: 'Inactive' };

    const { res, next } = await run(updateModule('barangays'), {
      params: ID,
      body: { ...body },
    });

    expect(next).not.toHaveBeenCalled();
    const [sql, params] = callFor('UPDATE barangays');
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual(['Balanti', 'Maria', '0917', 'Inactive', '7']);
    expect(dataOf(res)).toEqual({ id: '7', ...body });
  });

  it('can deactivate an office', async () => {
    await run(updateModule('offices'), {
      params: ID,
      body: { name: 'Health Office', barangay: 'Balanti', status: 'Inactive' },
    });

    expect(callFor('UPDATE offices')[1]).toEqual([
      'Health Office',
      'Balanti',
      '',
      'Inactive',
      '7',
    ]);
  });

  it('returns 404 when no record was updated', async () => {
    setupDb({ affectedRows: 0 });

    const { res } = await run(updateModule('barangays'), {
      params: ID,
      body: { name: 'Nowhere' },
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Record not found' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(updateModule('barangays'), { params: ID, body: { name: 'Balanti' } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'barangays.update',
        entityType: 'barangays',
        entityId: '7',
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('barangays:changed', {
      action: 'updated',
      id: '7',
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'barangays-updated',
    });
  });

  it.each(['requests', 'notifications', 'auditLogs'])(
    'does not allow updating %s through this route (405)',
    async (moduleName) => {
      const { res } = await run(updateModule(moduleName), {
        params: ID,
        body: { status: 'Approved' },
      });

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({
        message: 'This module does not support updates',
      });
      expect(pool.execute).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    },
  );

  it('passes database errors to next', async () => {
    setupDb({ updateError: new Error('Database is down') });

    const { res, next } = await run(updateModule('barangays'), {
      params: ID,
      body: { name: 'Balanti' },
    });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

// =====================================================
// NOTIFICATIONS
// =====================================================

describe('notifications: who sees which ones', () => {
  const listCall = () => callFor('FROM notifications');

  it('scopes a resident to their own and broadcast notifications', async () => {
    await run(listModule('notifications'), { user: resident() });

    expect(listCall()[0]).toContain('user_id IS NULL');
    expect(listCall()[1]).toEqual([12, 'resident', 'resident']);
  });

  it('scopes an admin by their own id and role', async () => {
    await run(listModule('notifications'), { user: admin });
    expect(listCall()[1]).toEqual([1, 'admin', 'admin']);
  });

  it('uses the account type when the user has no role', async () => {
    await run(listModule('notifications'), { user: { id: 5, accountType: 'staff' } });
    expect(listCall()[1]).toEqual([5, 'staff', 'staff']);
  });

  it('treats a user with no id or role as a resident with id 0', async () => {
    await run(listModule('notifications'), { user: {} });
    expect(listCall()[1]).toEqual([0, 'resident', 'resident']);
  });

  it('treats a missing user the same way', async () => {
    await run(listModule('notifications'), { user: undefined });
    expect(listCall()[1]).toEqual([0, 'resident', 'resident']);
  });

  it('sorts newest first', async () => {
    await run(listModule('notifications'));
    expect(listCall()[0]).toContain('ORDER BY created_at DESC');
  });
});

describe('notifications: marking one as read', () => {
  const ID = { id: '5' };

  it('marks it read only within the user\'s own scope', async () => {
    const { res, next } = await run(markNotificationRead, {
      user: resident(),
      params: ID,
    });

    const [sql, params] = callFor('UPDATE notifications');
    expect(next).not.toHaveBeenCalled();
    expect(sql).toContain('WHERE id = ? AND (');
    expect(params).toEqual(['5', 12, 'resident', 'resident']);
    expect(dataOf(res)).toEqual({ id: '5', readAt: new Date().toISOString() });
  });

  it('returns 404 when it is not found or belongs to someone else', async () => {
    setupDb({ affectedRows: 0 });

    const { res } = await run(markNotificationRead, { user: resident(), params: ID });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Notification not found' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('records an audit entry and sends a realtime event', async () => {
    await run(markNotificationRead, { user: resident(), params: ID });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notifications.mark_read',
        entityType: 'notifications',
        entityId: '5',
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
      action: 'read',
      id: '5',
      userId: 12,
      userRole: 'resident',
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { next } = await run(markNotificationRead, { user: resident(), params: ID });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
  });
});

describe('notifications: summary and mark all', () => {
  it('returns the total and unread counts as numbers', async () => {
    setupDb({ rows: [{ total: '5', unread: '2' }] });

    const { res } = await run(getNotificationSummary, { user: resident() });

    expect(dataOf(res)).toEqual({ total: 5, unread: 2 });
    expect(callFor('COUNT(*)')[1]).toEqual([12, 'resident', 'resident']);
  });

  it('shows 0 unread when the database returns nothing for it', async () => {
    setupDb({ rows: [{ total: '0', unread: null }] });

    const { res } = await run(getNotificationSummary, { user: resident() });

    expect(dataOf(res)).toEqual({ total: 0, unread: 0 });
  });

  it('marks all unread notifications as read within the user\'s scope', async () => {
    setupDb({ affectedRows: 3 });

    const { res } = await run(markAllNotificationsRead, { user: resident() });

    const [sql, params] = callFor('UPDATE notifications');
    expect(sql).toContain('read_at IS NULL');
    expect(params).toEqual([12, 'resident', 'resident']);
    expect(dataOf(res)).toEqual({ updated: 3 });
  });

  it('records an audit entry and sends a realtime event for mark all', async () => {
    setupDb({ affectedRows: 3 });

    await run(markAllNotificationsRead, { user: resident() });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notifications.mark_all_read',
        entityType: 'notifications',
        details: { affectedRows: 3 },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
      action: 'all-read',
      userId: 12,
      userRole: 'resident',
    });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const summary = await run(getNotificationSummary, { user: resident() });
    const markAll = await run(markAllNotificationsRead, { user: resident() });

    expect(summary.next.mock.calls[0][0].message).toBe('Database is down');
    expect(markAll.next.mock.calls[0][0].message).toBe('Database is down');
  });
});

// =====================================================
// STAFF ACCOUNTS (FR15 to FR17)
// =====================================================

describe('staff accounts: listing', () => {
  const rows = () => [
    {
      id: 3,
      name: 'Sam Staff',
      email: 'sam@example.com',
      barangay: 'Balanti',
      officeId: 2,
      officeName: 'Health Office',
      role: 'barangay_staff',
      permissions: '["reports:read"]',
      status: 'Active',
      createdAt: '2026-01-01',
    },
    {
      id: 4,
      name: 'Ana Admin',
      email: 'ana@example.com',
      barangay: null,
      officeId: null,
      officeName: null,
      role: 'admin',
      permissions: null,
      status: 'Active',
      createdAt: '2026-01-01',
    },
  ];

  it('returns each staff member with their permissions cleaned up and counted', async () => {
    setupDb({ rows: rows() });

    const { res } = await run(listStaff);
    const [sam, ana] = dataOf(res);

    expect(sam).toMatchObject({
      id: 3,
      name: 'Sam Staff',
      email: 'sam@example.com',
      permissions: ['reports:read'],
      permissionCount: 1,
    });
    expect(ana.permissions).toEqual(Object.values(PERMISSIONS));
    expect(ana.permissionCount).toBe(Object.values(PERMISSIONS).length);
  });

  it('never asks the database for password hashes', async () => {
    setupDb({ rows: rows() });

    await run(listStaff);

    expect(pool.query.mock.calls[0][0]).not.toContain('password');
  });

  it('passes database errors to next', async () => {
    pool.query.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(listStaff);

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('staff accounts: creating (FR15)', () => {
  const makeBody = (extra = {}) => ({
    name: 'Sam Staff',
    email: 'sam@example.com',
    barangay: 'Balanti',
    officeId: 2,
    role: 'barangay_staff',
    password: 'NewPass123',
    ...extra,
  });
  const create = (body = makeBody()) => run(createStaff, { body });
  const insertCall = () => callFor('INSERT INTO staff_accounts');

  it('creates the account and responds with 201', async () => {
    const { res, next } = await create();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(dataOf(res)).toEqual({
      id: 20,
      name: 'Sam Staff',
      email: 'sam@example.com',
      barangay: 'Balanti',
      officeId: 2,
      role: 'barangay_staff',
      permissions: rolePermissions[ROLES.BARANGAY_STAFF],
      status: 'Active',
    });
  });

  it('saves every value in the right order with a safe query', async () => {
    await create();

    const [sql, params] = insertCall();
    expect(sql).not.toContain('sam@example.com');
    expect(params).toEqual([
      'Sam Staff',
      'sam@example.com',
      'Balanti',
      2,
      'hashed',
      'barangay_staff',
      JSON.stringify(rolePermissions[ROLES.BARANGAY_STAFF]),
      'Active',
    ]);
  });

  it('hashes the password before saving it', async () => {
    await create();

    expect(hashPassword).toHaveBeenCalledWith('NewPass123');
    expect(insertCall()[1][4]).toBe('hashed');
  });

  it('fills in defaults for the optional fields', async () => {
    await create({ name: 'Sam Staff', email: 'sam@example.com', password: 'NewPass123' });

    const params = insertCall()[1];
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
    expect(params[5]).toBe('barangay_staff');
    expect(params[7]).toBe('Active');
  });

  it('keeps only valid permissions', async () => {
    await create(makeBody({ permissions: ['reports:read', 'fake:perm'] }));
    expect(insertCall()[1][6]).toBe(JSON.stringify(['reports:read']));
  });

  it('gives an admin every permission when none are listed', async () => {
    await create(makeBody({ role: 'admin' }));
    expect(insertCall()[1][6]).toBe(JSON.stringify(Object.values(PERMISSIONS)));
  });

  it('can create the account as inactive', async () => {
    await create(makeBody({ status: 'Inactive' }));
    expect(insertCall()[1][7]).toBe('Inactive');
  });

  it('records an audit entry that never contains the password', async () => {
    await create();

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'staff.create',
        entityType: 'staff_accounts',
        entityId: 20,
      }),
    );
    expect(JSON.stringify(logAudit.mock.calls[0][0])).not.toContain('NewPass123');
  });

  it('sends a realtime event', async () => {
    await create();

    expect(emitRealtimeEvent).toHaveBeenCalledWith('staff:changed', {
      action: 'created',
      id: 20,
    });
  });

  it.each([
    [{ name: '', email: 'sam@example.com' }],
    [{ name: 'Sam', email: '' }],
    [{ name: undefined, email: undefined }],
  ])('requires a name and an email (%j)', async (fields) => {
    const { res } = await create(makeBody(fields));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Name and email are required' });
    expect(pool.execute).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it.each(['short', 'password1', 'Password1!'])(
    'rejects the weak password %s',
    async (password) => {
      const { res } = await create(makeBody({ password }));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: PASSWORD_POLICY_MESSAGE });
      expect(insertCall()).toBeUndefined();
      expect(hashPassword).not.toHaveBeenCalled();
    },
  );

  it('returns 409 for an email that is already used', async () => {
    setupDb({ insertError: duplicateError() });

    const { res, next } = await create();

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'A staff account already exists for this email',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes other database errors to next', async () => {
    setupDb({ insertError: new Error('Database is down') });

    const { res, next } = await create();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('staff accounts: updating and deactivating (FR15, FR16)', () => {
  const ID = { id: '3' };
  const makeBody = (extra = {}) => ({
    name: 'Sam Staff',
    email: 'sam@example.com',
    barangay: 'Balanti',
    officeId: 2,
    role: 'barangay_staff',
    status: 'Active',
    ...extra,
  });
  const update = (body = makeBody(), req = {}) =>
    run(updateStaff, { params: ID, body, ...req });
  const updateCall = () => callFor('UPDATE staff_accounts');
  const PERMS = JSON.stringify(rolePermissions[ROLES.BARANGAY_STAFF]);

  it('saves every value with a safe query when no password is sent', async () => {
    const { res, next } = await update();

    expect(next).not.toHaveBeenCalled();
    const [sql, params] = updateCall();
    expect(sql).toContain('WHERE id = ?');
    expect(sql).not.toContain('password_hash');
    expect(params).toEqual([
      'Sam Staff',
      'sam@example.com',
      'Balanti',
      2,
      'barangay_staff',
      PERMS,
      'Active',
      '3',
    ]);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(dataOf(res)).toEqual({
      id: '3',
      name: 'Sam Staff',
      email: 'sam@example.com',
      barangay: 'Balanti',
      officeId: 2,
      role: 'barangay_staff',
      permissions: rolePermissions[ROLES.BARANGAY_STAFF],
      status: 'Active',
    });
  });

  it('deactivates a staff account (FR16)', async () => {
    await update(makeBody({ status: 'Inactive' }));
    expect(updateCall()[1][6]).toBe('Inactive');
  });

  it('reactivates a staff account', async () => {
    await update(makeBody({ status: 'Active' }));
    expect(updateCall()[1][6]).toBe('Active');
  });

  it('saves a new hashed password', async () => {
    await update(makeBody({ password: 'NewPass123' }));

    const [sql, params] = updateCall();
    expect(hashPassword).toHaveBeenCalledWith('NewPass123');
    expect(sql).toContain(', password_hash = ?');
    expect(params.slice(-2)).toEqual(['hashed', '3']);
  });

  it.each([0, '', null, undefined])(
    'saves an empty office (%s) as null',
    async (officeId) => {
      await update(makeBody({ officeId }));
      expect(updateCall()[1][3]).toBeNull();
    },
  );

  it('keeps only valid permissions', async () => {
    await update(makeBody({ permissions: ['reports:read', 'fake:perm'] }));
    expect(updateCall()[1][5]).toBe(JSON.stringify(['reports:read']));
  });

  it.each([
    [{ name: '', email: 'sam@example.com' }],
    [{ name: 'Sam', email: '' }],
  ])('requires a name and an email (%j)', async (fields) => {
    const { res } = await update(makeBody(fields));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Name and email are required' });
    expect(updateCall()).toBeUndefined();
  });

  it.each(['short', 'password1', 'Password1!'])(
    'rejects the weak password %s',
    async (password) => {
      const { res } = await update(makeBody({ password }));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: PASSWORD_POLICY_MESSAGE });
      expect(updateCall()).toBeUndefined();
      expect(hashPassword).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the account does not exist', async () => {
    setupDb({ staffRow: null });

    const { res } = await update();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Staff account not found' });
    expect(updateCall()).toBeUndefined();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('records an audit entry that never contains the password', async () => {
    await update(makeBody({ password: 'NewPass123' }));

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'staff.update',
        entityType: 'staff_accounts',
        entityId: '3',
        details: expect.objectContaining({ passwordChanged: true }),
      }),
    );
    expect(JSON.stringify(logAudit.mock.calls[0][0])).not.toContain('NewPass123');
  });

  it('notes in the audit entry when the password was not changed', async () => {
    await update();

    expect(logAudit.mock.calls[0][0].details.passwordChanged).toBe(false);
  });

  it('sends realtime events', async () => {
    await update();

    expect(emitRealtimeEvent).toHaveBeenCalledWith('staff:changed', {
      action: 'updated',
      id: '3',
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'staff-updated',
    });
  });

  it('returns 409 for an email that is already used', async () => {
    setupDb({ updateError: duplicateError() });

    const { res, next } = await update();

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'A staff account already exists for this email',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes other database errors to next', async () => {
    setupDb({ updateError: new Error('Database is down') });

    const { res, next } = await update();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

// =====================================================
// ANNOUNCEMENTS
// =====================================================

describe('announcements: who sees which ones', () => {
  const listCall = () => callFor('ORDER BY pinned DESC');
  const writer = { ...admin, permissions: ['announcements:write'] };

  it('shows everything to users who can write announcements', async () => {
    await run(listModule('announcements'), { user: writer });

    expect(listCall()[0]).not.toContain("status = 'Published'");
    expect(listCall()[1]).toEqual([]);
  });

  it('shows residents only published, unexpired announcements for them or everyone', async () => {
    setupDb({ userBarangay: 'Balanti' });

    await run(listModule('announcements'), { user: resident() });

    const [sql, params] = listCall();
    expect(sql).toContain("status = 'Published'");
    expect(sql).toContain('expires_at IS NULL OR expires_at >= NOW()');
    expect(params).toEqual(['All', 'Residents', 'Balanti']);
  });

  it('shows staff the Barangay Staff audience', async () => {
    await run(listModule('announcements'), { user: staff() });
    expect(listCall()[1].slice(0, 2)).toEqual(['All', 'Barangay Staff']);
  });

  it('shows admins without write access the Admins audience', async () => {
    await run(listModule('announcements'), { user: admin });
    expect(listCall()[1].slice(0, 2)).toEqual(['All', 'Admins']);
  });

  it('uses the barangay saved in the database over the one in the token', async () => {
    setupDb({ userBarangay: 'New Barangay' });

    await run(listModule('announcements'), { user: resident({ barangay: 'Old' }) });

    expect(listCall()[1]).toEqual(['All', 'Residents', 'New Barangay']);
  });

  it('falls back to the barangay in the token', async () => {
    await run(listModule('announcements'), { user: resident() });
    expect(listCall()[1]).toEqual(['All', 'Residents', 'Balanti']);
  });

  it('shows only announcements for everyone when the user has no barangay', async () => {
    await run(listModule('announcements'), {
      user: resident({ barangay: undefined }),
    });

    expect(listCall()[0]).toContain('barangay IS NULL');
    expect(listCall()[1]).toEqual(['All', 'Residents']);
  });

  it('sorts pinned announcements first', async () => {
    await run(listModule('announcements'), { user: writer });
    expect(listCall()[0]).toContain('ORDER BY pinned DESC');
  });
});

describe('announcements: creating', () => {
  const makeBody = (extra = {}) => ({
    title: 'Typhoon advisory',
    content: 'Stay safe',
    audience: 'All',
    status: 'Draft',
    ...extra,
  });
  const create = (body = makeBody(), req = {}) =>
    run(createModule('announcements'), { user: staff(), body, ...req });
  const insertCall = () => callFor('INSERT INTO announcements');

  it('saves a draft with defaults and the author', async () => {
    const { res, next } = await create();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(insertCall()[1]).toEqual([
      'Typhoon advisory',
      'Stay safe',
      null,
      'All',
      null,
      'Advisory',
      'Normal',
      0,
      'Draft',
      null,
      null,
      2,
      'Sam Staff',
    ]);
  });

  it('sets the published date when it is published', async () => {
    await create(makeBody({ status: 'Published' }));
    expect(insertCall()[1][9]).toEqual(new Date());
  });

  it.each([
    [true, 1],
    [1, 1],
    ['1', 1],
    ['true', 1],
    [false, 0],
    ['no', 0],
    [undefined, 0],
  ])('saves pinned %s as %s', async (pinned, saved) => {
    await create(makeBody({ pinned }));
    expect(insertCall()[1][7]).toBe(saved);
  });

  it('saves an empty barangay and an empty expiry as null', async () => {
    await create(makeBody({ barangay: '', expiresAt: '' }));

    expect(insertCall()[1][4]).toBeNull();
    expect(insertCall()[1][10]).toBeNull();
  });

  it('saves the uploaded poster path', async () => {
    await create(makeBody(), { file: { path: 'uploads/poster.jpg' } });
    expect(insertCall()[1][2]).toBe('uploads/poster.jpg');
  });

  it('records an audit entry and sends a realtime event', async () => {
    await create();

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'announcements.create',
        entityType: 'announcements',
        entityId: 20,
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('announcements:changed', {
      action: 'created',
      id: 20,
    });
  });

  describe('notifying residents when published', () => {
    const noResidentEvent = () =>
      expect(emitRealtimeEvent).not.toHaveBeenCalledWith(
        'notifications:changed',
        expect.anything(),
      );

    it('notifies every verified and active resident', async () => {
      setupDb({ residents: [{ id: 12 }, { id: 13 }] });

      await create(makeBody({ status: 'Published' }));

      const [selectSql, selectParams] = callFor('FROM resident_accounts WHERE verification_status');
      expect(selectSql).toContain("verification_status = 'Verified'");
      expect(selectSql).toContain("account_status = 'Active'");
      expect(selectParams).toEqual([]);

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query.mock.calls[0][0]).toContain('INSERT INTO notifications');
      expect(pool.query.mock.calls[0][1]).toEqual([
        [
          [12, 'resident', 'New announcement', 'Typhoon advisory'],
          [13, 'resident', 'New announcement', 'Typhoon advisory'],
        ],
      ]);
      expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
        action: 'created',
        userRole: 'resident',
      });
    });

    it('limits notifications to one barangay when the announcement has one', async () => {
      setupDb({ residents: [{ id: 12 }] });

      await create(makeBody({ status: 'Published', barangay: 'Balanti' }));

      const [selectSql, selectParams] = callFor('FROM resident_accounts WHERE verification_status');
      expect(selectSql).toContain('barangay = ?');
      expect(selectParams).toEqual(['Balanti']);
    });

    it('adds "Urgent:" to the message for urgent announcements', async () => {
      setupDb({ residents: [{ id: 12 }] });

      await create(makeBody({ status: 'Published', priority: 'Urgent' }));

      expect(pool.query.mock.calls[0][1][0][0][3]).toBe('Urgent: Typhoon advisory');
    });

    it('notifies residents when the audience is Residents', async () => {
      setupDb({ residents: [{ id: 12 }] });

      await create(makeBody({ status: 'Published', audience: 'Residents' }));

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it.each(['Admins', 'Barangay Staff'])(
      'does not notify residents when the audience is %s',
      async (audience) => {
        setupDb({ residents: [{ id: 12 }] });

        await create(makeBody({ status: 'Published', audience }));

        expect(pool.query).not.toHaveBeenCalled();
        noResidentEvent();
      },
    );

    it('does not notify anyone for a draft', async () => {
      setupDb({ residents: [{ id: 12 }] });

      await create(makeBody({ status: 'Draft' }));

      expect(pool.query).not.toHaveBeenCalled();
      noResidentEvent();
    });

    it('sends nothing when there are no matching residents', async () => {
      setupDb({ residents: [] });

      await create(makeBody({ status: 'Published' }));

      expect(pool.query).not.toHaveBeenCalled();
      noResidentEvent();
    });
  });
});

describe('announcements: updating', () => {
  const ID = { id: '9' };
  const makeBody = (extra = {}) => ({
    title: 'Typhoon advisory',
    content: 'Stay safe',
    audience: 'All',
    status: 'Published',
    pinned: true,
    ...extra,
  });

  it('saves every value with a safe query', async () => {
    const { res } = await run(updateModule('announcements'), {
      user: staff(),
      params: ID,
      body: makeBody(),
    });

    const [sql, params] = callFor('UPDATE announcements');
    expect(sql).toContain('COALESCE(?, poster_image)');
    expect(params).toEqual([
      'Typhoon advisory',
      'Stay safe',
      null,
      'All',
      null,
      'Advisory',
      'Normal',
      1,
      'Published',
      null,
      'Published',
      'Published',
      '9',
    ]);
    expect(dataOf(res)).toMatchObject({ id: '9', title: 'Typhoon advisory' });
  });

  it('saves a newly uploaded poster', async () => {
    await run(updateModule('announcements'), {
      user: staff(),
      params: ID,
      body: makeBody(),
      file: { path: 'uploads/new.jpg' },
    });

    expect(callFor('UPDATE announcements')[1][2]).toBe('uploads/new.jpg');
  });

  it('notifies residents when an announcement is published', async () => {
    setupDb({ residents: [{ id: 12 }] });

    await run(updateModule('announcements'), {
      user: staff(),
      params: ID,
      body: makeBody(),
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('does not notify residents when saved as a draft', async () => {
    setupDb({ residents: [{ id: 12 }] });

    await run(updateModule('announcements'), {
      user: staff(),
      params: ID,
      body: makeBody({ status: 'Draft' }),
    });

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 404 when the announcement does not exist', async () => {
    setupDb({ affectedRows: 0 });

    const { res } = await run(updateModule('announcements'), {
      user: staff(),
      params: ID,
      body: makeBody(),
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Record not found' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('announcements: deleting', () => {
  const ID = { id: '4' };

  it('deletes the announcement with a safe query', async () => {
    const { res } = await run(deleteAnnouncement, { params: ID });

    const [sql, params] = callFor('DELETE FROM announcements');
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual(['4']);
    expect(dataOf(res)).toEqual({ id: '4', deleted: true });
  });

  it('returns 404 when it does not exist', async () => {
    setupDb({ affectedRows: 0 });

    const { res } = await run(deleteAnnouncement, { params: ID });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Announcement not found' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  });

  it('records an audit entry and sends realtime events', async () => {
    await run(deleteAnnouncement, { params: ID });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'announcements.delete',
        entityType: 'announcements',
        entityId: '4',
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('announcements:changed', {
      action: 'deleted',
      id: '4',
    });
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'announcement-deleted',
    });
  });
});

describe('announcements: poster access', () => {
  const ID = { id: '4' };
  const writer = { ...admin, permissions: ['announcements:write'] };
  const fetchPoster = (user = resident()) =>
    run(getAnnouncementPoster, { user, params: ID });
  const denied = 'You do not have permission to view this announcement poster';

  beforeEach(() => {
    setupDb({ poster: posterRow() });
    fs.existsSync.mockReturnValue(true);
  });

  it('sends the poster to a resident for a published announcement', async () => {
    const { res, next } = await fetchPoster();

    expect(next).not.toHaveBeenCalled();
    expect(res.sendFile).toHaveBeenCalledWith(path.resolve('uploads/poster.jpg'));
  });

  it('looks the announcement up with a safe query', async () => {
    await fetchPoster();
    expect(callFor('WHERE id = ?')[1]).toEqual(['4']);
  });

  it('lets users who can write announcements see drafts', async () => {
    setupDb({ poster: posterRow({ status: 'Draft' }) });

    const { res } = await fetchPoster(writer);

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('blocks a draft from everyone else', async () => {
    setupDb({ poster: posterRow({ status: 'Draft' }) });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: denied });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('blocks an expired announcement', async () => {
    setupDb({ poster: posterRow({ expiresAt: new Date(2026, 5, 1).toISOString() }) });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('allows an announcement that has not expired yet', async () => {
    setupDb({ poster: posterRow({ expiresAt: new Date(2026, 6, 1).toISOString() }) });

    const { res } = await fetchPoster();

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('blocks a resident from an Admins-only announcement', async () => {
    setupDb({ poster: posterRow({ audience: 'Admins' }) });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a resident to see a Residents announcement', async () => {
    setupDb({ poster: posterRow({ audience: 'Residents' }) });

    const { res } = await fetchPoster();

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('allows staff to see a Barangay Staff announcement', async () => {
    setupDb({ poster: posterRow({ audience: 'Barangay Staff' }) });

    const { res } = await fetchPoster(staff());

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('blocks an announcement for another barangay', async () => {
    setupDb({ poster: posterRow({ barangay: 'Other' }) });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('matches the barangay even when it is written with a "Barangay" prefix', async () => {
    setupDb({ poster: posterRow({ barangay: 'Barangay Balanti' }) });

    const { res } = await fetchPoster();

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('does not check the disk before the access check passes', async () => {
    setupDb({ poster: posterRow({ status: 'Draft' }) });

    await fetchPoster();

    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('returns 404 when the announcement does not exist', async () => {
    setupDb({ poster: null });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Announcement poster not found' });
  });

  it('returns 404 when the announcement has no poster', async () => {
    setupDb({ poster: posterRow({ posterImage: null }) });

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Announcement poster not found' });
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('returns 404 when the file is missing from disk', async () => {
    fs.existsSync.mockReturnValue(false);

    const { res } = await fetchPoster();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Announcement poster file was not found on disk',
    });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await fetchPoster();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.sendFile).not.toHaveBeenCalled();
  });
});