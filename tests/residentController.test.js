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
  pool: { execute: vi.fn() },
}));
vi.mock('../src/config/mailer.js', () => ({
  sendAccountStatusEmail: vi.fn(),
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
vi.mock('../src/utils/residentName.js', () => ({
  formatResidentName: (first, middle, last) =>
    [first, middle, last].filter(Boolean).join(' '),
  normalizeMiddleName: (value) => value || null,
}));

import fs from 'node:fs';
import { pool } from '../src/config/db.js';
import { sendAccountStatusEmail } from '../src/config/mailer.js';
import { emitRealtimeEvent } from '../src/realtime/socket.js';
import { logAudit } from '../src/utils/auditLogger.js';
import { hashPassword } from '../src/utils/password.js';
import { PASSWORD_POLICY_MESSAGE } from '../src/utils/passwordPolicy.js';
import {
  getResidents,
  createResident,
  updateResident,
  getMyResidentProfile,
  updateMyResidentProfile,
  updateResidentStatus,
  getResidentSelfieId,
} from '../src/controllers/residentController.js';

// Freeze "today" at June 15, 2026 so ages are the same on any day.
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

const admin = { id: 1, name: 'Ana Admin', role: 'admin', permissions: [] };

const staff = (overrides = {}) => ({
  id: 2,
  name: 'Sam Staff',
  role: 'barangay_staff',
  barangay: 'Balanti',
  permissions: [],
  ...overrides,
});

const residentUser = {
  id: 12,
  role: 'resident',
  accountType: 'resident',
  barangay: 'Balanti',
};

// A resident row as the database would return it.
const residentRow = (overrides = {}) => ({
  id: 12,
  first_name: 'Juan',
  middle_name: null,
  last_name: 'Cruz',
  email: 'juan@example.com',
  contact_number: '09171234567',
  barangay: 'Balanti',
  purok_sitio: 'Purok 1',
  street_address: '123 Rizal St',
  birth_date: '2000-06-15',
  age: 26,
  gender: 'Male',
  civil_status: 'Single',
  nationality: 'Filipino',
  household_status: 'Household Head',
  selfie_id_image: null,
  role: 'resident',
  verification_status: 'Verified',
  account_status: 'Active',
  status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  served_programs: 0,
  ...overrides,
});

const pendingRow = (overrides = {}) =>
  residentRow({
    verification_status: 'Pending',
    account_status: 'Inactive',
    status: 'Pending',
    ...overrides,
  });

// Sets up a fake database that answers by recognizing the SQL text.
const setupDb = (overrides = {}) => {
  const state = {
    resident: residentRow(),
    list: [],
    selfie: null,
    insertId: 12,
    insertError: null,
    updateError: null,
    affectedRows: 1,
    ...overrides,
  };

  pool.execute.mockImplementation(async (sql) => {
    if (sql.includes('selfie_id_image FROM resident_accounts')) {
      return [state.selfie ? [state.selfie] : []];
    }
    if (sql.includes('INSERT INTO resident_accounts')) {
      if (state.insertError) throw state.insertError;
      return [{ insertId: state.insertId }];
    }
    if (sql.includes('UPDATE resident_accounts')) {
      if (state.updateError) throw state.updateError;
      return [{ affectedRows: state.affectedRows }];
    }
    if (sql.includes('ORDER BY ra.created_at DESC')) {
      return [state.list];
    }
    if (sql.includes('WHERE ra.id = ?')) {
      return [state.resident ? [state.resident] : []];
    }
    return [{ affectedRows: 1 }];
  });
};

const callFor = (text) =>
  pool.execute.mock.calls.find(([sql]) => sql.includes(text));

const run = async (handler, req = {}) => {
  const res = createRes();
  const next = vi.fn();
  await handler({ user: admin, params: {}, body: {}, ...req }, res, next);
  return { res, next };
};

const dataOf = (res) => res.json.mock.calls[0][0].data;

const duplicateError = () =>
  Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pool.execute.mockReset();
  logAudit.mockReset();
  emitRealtimeEvent.mockReset();
  hashPassword.mockReset();
  hashPassword.mockReturnValue('hashed');
  sendAccountStatusEmail.mockReset();
  sendAccountStatusEmail.mockResolvedValue(undefined);
  fs.existsSync.mockReset();
  setupDb();
});

// ---------- getResidents ----------

describe('getResidents: who sees which residents', () => {
  const listCall = () => callFor('ORDER BY ra.created_at DESC');

  it('shows every barangay to an admin', async () => {
    await run(getResidents, { user: admin });

        expect(listCall()[0]).not.toContain('WHERE ra.barangay');
    expect(listCall()[1]).toEqual([]);
  });

  it('limits staff to their own barangay', async () => {
    await run(getResidents, { user: staff() });

    expect(listCall()[0]).toContain('WHERE ra.barangay = ?');
    expect(listCall()[1]).toEqual(['Balanti']);
  });

  it('shows staff with no barangay nothing instead of everything', async () => {
    await run(getResidents, { user: staff({ barangay: undefined }) });
    expect(listCall()[1]).toEqual(['']);
  });

  it('shows every barangay to staff with the view-all permission', async () => {
    await run(getResidents, {
      user: staff({ permissions: ['residents:view_all'] }),
    });
    expect(listCall()[1]).toEqual([]);
  });

  it('sorts newest first', async () => {
    await run(getResidents);
    expect(listCall()[0]).toContain('ORDER BY ra.created_at DESC');
  });

  it('never selects the password hash', async () => {
    await run(getResidents);
    expect(listCall()[0]).not.toContain('password');
  });

  it('passes database errors to next and sends no response', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run(getResidents);

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('getResidents: resident details in the response', () => {
  const firstResident = async (row) => {
    setupDb({ list: [row] });
    const { res } = await run(getResidents);
    return dataOf(res)[0];
  };

  it('returns the complete profile', async () => {
    expect(await firstResident(residentRow())).toEqual({
      id: 'RES-0012',
      rawId: 12,
      name: 'Juan Cruz',
      firstName: 'Juan',
      middleName: '',
      lastName: 'Cruz',
      email: 'juan@example.com',
      contact: '09171234567',
      contactNumber: '09171234567',
      barangay: 'Balanti',
      purokSitio: 'Purok 1',
      streetAddress: '123 Rizal St',
      address: '123 Rizal St, Purok 1, Brgy. Balanti, Tarlac City',
      birthDate: '2000-06-15',
      age: 26,
      preciseAge: '26 years',
      gender: 'Male',
      civilStatus: 'Single',
      nationality: 'Filipino',
      householdStatus: 'Household Head',
      servedPrograms: 0,
      beneficiaryStatus: 'Not a beneficiary',
      hasSelfieId: false,
      verificationStatus: 'Verified',
      accountStatus: 'Active',
      status: 'Verified',
      role: 'resident',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns an empty list when there are no residents', async () => {
    setupDb({ list: [] });
    const { res } = await run(getResidents);
    expect(dataOf(res)).toEqual([]);
  });

  it('returns one entry per resident, in database order', async () => {
    setupDb({ list: [residentRow({ id: 2 }), residentRow({ id: 1 })] });
    const { res } = await run(getResidents);
    expect(dataOf(res).map((r) => r.rawId)).toEqual([2, 1]);
  });

  it('formats the id with leading zeros', async () => {
    expect((await firstResident(residentRow({ id: 7 }))).id).toBe('RES-0007');
    expect((await firstResident(residentRow({ id: 12345 }))).id).toBe('RES-12345');
  });

  it('includes the middle name in the full name', async () => {
    const resident = await firstResident(residentRow({ middle_name: 'Dela' }));
    expect(resident.name).toBe('Juan Dela Cruz');
    expect(resident.middleName).toBe('Dela');
  });

  it('works out the age from the birthdate, not the stored age', async () => {
    const resident = await firstResident(
      residentRow({ birth_date: '1990-01-01', age: 99 }),
    );
    expect(resident.age).toBe(36);
  });

  it('falls back to the stored age when there is no birthdate', async () => {
    const resident = await firstResident(
      residentRow({ birth_date: null, age: 40 }),
    );
    expect(resident.age).toBe(40);
    expect(resident.preciseAge).toBe('');
  });

  it('shows the email as the contact when there is no contact number', async () => {
    const resident = await firstResident(residentRow({ contact_number: null }));
    expect(resident.contact).toBe('juan@example.com');
    expect(resident.contactNumber).toBe('');
  });

  it('fills in defaults for empty fields', async () => {
    const resident = await firstResident(
      residentRow({
        gender: null,
        civil_status: null,
        household_status: null,
        nationality: null,
        purok_sitio: null,
        street_address: null,
      }),
    );
    expect(resident).toMatchObject({
      gender: 'Unspecified',
      civilStatus: 'Unspecified',
      householdStatus: 'Unspecified',
      nationality: '',
      purokSitio: '',
      streetAddress: '',
    });
  });

  it('describes beneficiaries by how many programs served them', async () => {
    const one = await firstResident(residentRow({ served_programs: 1 }));
    const many = await firstResident(residentRow({ served_programs: '3' }));

    expect(one.beneficiaryStatus).toBe('Beneficiary (1 program)');
    expect(many.beneficiaryStatus).toBe('Beneficiary (3 programs)');
    expect(many.servedPrograms).toBe(3);
  });

  it('says whether an ID selfie exists without exposing its file path', async () => {
    setupDb({ list: [residentRow({ selfie_id_image: 'uploads/secret-id.jpg' })] });
    const { res } = await run(getResidents);

    expect(dataOf(res)[0].hasSelfieId).toBe(true);
    expect(JSON.stringify(dataOf(res))).not.toContain('secret-id.jpg');
  });

  it('reads older rows that only have the combined status', async () => {
    const pending = await firstResident(
      residentRow({ verification_status: null, account_status: null, status: 'Pending' }),
    );
    expect(pending).toMatchObject({
      verificationStatus: 'Pending',
      accountStatus: 'Active',
      status: 'Pending',
    });

    const inactive = await firstResident(
      residentRow({ verification_status: null, account_status: null, status: 'Inactive' }),
    );
    expect(inactive.accountStatus).toBe('Inactive');
  });
});

// ---------- createResident (FR4, BB-04) ----------

describe('createResident: saving', () => {
  const validBody = {
    firstName: 'Juan',
    lastName: 'Cruz',
    email: 'juan@example.com',
    barangay: 'Balanti',
    birthDate: '2000-06-15',
  };

  const create = (body = validBody, req = {}) =>
    run(createResident, { body, ...req });

  it('creates the resident and responds with 201', async () => {
    const { res, next } = await create();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(dataOf(res)).toMatchObject({ id: 'RES-0012', name: 'Juan Cruz' });
  });

  it('saves every value in the right order with a safe query', async () => {
    await create();

    const [sql, params] = callFor('INSERT INTO resident_accounts');
    expect(sql).not.toContain('juan@example.com');
    expect(params).toEqual([
      'Juan',
      null,
      'Cruz',
      'juan@example.com',
      '',
      'Balanti',
      '',
      '',
      '2000-06-15',
      26,
      'Unspecified',
      'Unspecified',
      null,
      'Unspecified',
      'hashed',
      null,
      'Pending',
      'Inactive',
      'Pending',
    ]);
  });

  it('saves the optional profile details that were sent', async () => {
    await create({
      ...validBody,
      middleName: 'Dela',
      gender: 'Male',
      civilStatus: 'Married',
      nationality: 'Filipino',
      householdStatus: 'Household Head',
      contactNumber: '0917 123 4567',
      purokSitio: 'Purok 5',
      streetAddress: '123 Rizal St',
    });

    const params = callFor('INSERT INTO resident_accounts')[1];
    expect(params.slice(0, 14)).toEqual([
      'Juan',
      'Dela',
      'Cruz',
      'juan@example.com',
      '0917 123 4567',
      'Balanti',
      'Purok 5',
      '123 Rizal St',
      '2000-06-15',
      26,
      'Male',
      'Married',
      'Filipino',
      'Household Head',
    ]);
  });

  it('works out the age from the birthdate and ignores a sent age', async () => {
    await create({ ...validBody, age: 99 });
    expect(callFor('INSERT INTO resident_accounts')[1][9]).toBe(26);
  });

  it('hashes the password before saving it', async () => {
    await create({ ...validBody, password: 'NewPass123' });

    expect(hashPassword).toHaveBeenCalledTimes(1);
    expect(hashPassword).toHaveBeenCalledWith('NewPass123');
    expect(callFor('INSERT INTO resident_accounts')[1][14]).toBe('hashed');
  });

  it('saves the uploaded selfie with ID path', async () => {
    await create(validBody, { file: { path: 'uploads/selfie.jpg' } });
    expect(callFor('INSERT INTO resident_accounts')[1][15]).toBe('uploads/selfie.jpg');
  });

  it('saves a verified and active account as active', async () => {
    await create({ ...validBody, verificationStatus: 'Verified', accountStatus: 'Active' });

    const params = callFor('INSERT INTO resident_accounts')[1];
    expect(params.slice(16)).toEqual(['Verified', 'Active', 'Active']);
  });

  it('forces an unverified account to inactive', async () => {
    await create({ ...validBody, verificationStatus: 'Rejected', accountStatus: 'Active' });

    const params = callFor('INSERT INTO resident_accounts')[1];
    expect(params.slice(16)).toEqual(['Rejected', 'Inactive', 'Rejected']);
  });

  it('accepts the older status field as the verification status', async () => {
    await create({ ...validBody, status: 'Verified', accountStatus: 'Active' });

    const params = callFor('INSERT INTO resident_accounts')[1];
    expect(params.slice(16)).toEqual(['Verified', 'Active', 'Active']);
  });

  it('records an audit entry without the password', async () => {
    await create({ ...validBody, password: 'NewPass123' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'residents.create',
        entityType: 'resident_accounts',
        entityId: 12,
      }),
    );
    const { details } = logAudit.mock.calls[0][0];
    expect(details.password).toBe('provided');
    expect(JSON.stringify(details)).not.toContain('NewPass123');
  });

  it('notes in the audit entry whether an ID selfie was uploaded', async () => {
    await create(validBody, { file: { path: 'uploads/selfie.jpg' } });
    expect(logAudit.mock.calls[0][0].details.hasSelfieId).toBe(true);

    logAudit.mockReset();
    await create();
    expect(logAudit.mock.calls[0][0].details.hasSelfieId).toBe(false);
  });

  it('sends realtime events', async () => {
    await create();

    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'residents:changed',
      expect.objectContaining({ action: 'created' }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'resident-created',
    });
  });

  it('returns 409 for an email that is already registered', async () => {
    setupDb({ insertError: duplicateError() });

    const { res, next } = await create();

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'A resident account already exists for this email',
    });
    expect(next).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('passes other database errors to next', async () => {
    setupDb({ insertError: new Error('Database is down') });

    const { res, next } = await create();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('createResident: validation (BB-05, BB-06)', () => {
  const validBody = {
    firstName: 'Juan',
    lastName: 'Cruz',
    email: 'juan@example.com',
    barangay: 'Balanti',
    birthDate: '2000-06-15',
  };

  const expectRejected = async (body, message) => {
    const { res, next } = await run(createResident, { body });

    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(message);
    expect(res.status).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO resident_accounts')).toBeUndefined();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  };

  const required =
    'First name, last name, email, barangay, and birthdate are required';

  it.each(['firstName', 'lastName', 'email', 'barangay', 'birthDate'])(
    'rejects a missing %s',
    async (field) => {
      await expectRejected({ ...validBody, [field]: '' }, required);
      await expectRejected({ ...validBody, [field]: undefined }, required);
    },
  );

  it('rejects an empty body', async () => {
    await expectRejected({}, required);
  });

  it.each(['not-a-date', '2026-02-30', '2030-01-01', '1900-01-01'])(
    'rejects the birthdate %s',
    async (birthDate) => {
      await expectRejected(
        { ...validBody, birthDate },
        'Birthdate must produce a valid resident age',
      );
    },
  );

  it('accepts someone born today (age 0)', async () => {
    const { next } = await run(createResident, {
      body: { ...validBody, birthDate: '2026-06-15' },
    });

    expect(next).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO resident_accounts')[1][9]).toBe(0);
  });

  it('accepts age 120 but rejects age 121', async () => {
    const oldest = await run(createResident, {
      body: { ...validBody, birthDate: '1905-06-16' },
    });
    expect(oldest.next).not.toHaveBeenCalled();
    expect(callFor('INSERT INTO resident_accounts')[1][9]).toBe(120);

    vi.clearAllMocks();
    await expectRejected(
      { ...validBody, birthDate: '1905-06-15' },
      'Birthdate must produce a valid resident age',
    );
  });

  it('rejects an unknown gender', async () => {
    await expectRejected({ ...validBody, gender: 'Other' }, 'Invalid resident gender');
  });

  it('rejects an unknown civil status', async () => {
    await expectRejected(
      { ...validBody, civilStatus: 'Divorced' },
      'Invalid resident civil status',
    );
  });

  it('rejects an unknown household status', async () => {
    await expectRejected(
      { ...validBody, householdStatus: 'Boarder' },
      'Invalid resident household status',
    );
  });

  it('rejects a contact number with letters', async () => {
    const { next } = await run(createResident, {
      body: { ...validBody, contactNumber: 'abc1234' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toContain('Contact number must be');
    expect(callFor('INSERT INTO resident_accounts')).toBeUndefined();
  });

  it('rejects an unknown verification status', async () => {
    await expectRejected(
      { ...validBody, verificationStatus: 'Banana' },
      'Invalid resident verification status',
    );
  });

  it('rejects an unknown account status', async () => {
    await expectRejected(
      { ...validBody, accountStatus: 'Frozen' },
      'Invalid resident account status',
    );
  });

  it.each(['short', 'password1', 'Password1!', 'Abcdefghijklm1'])(
    'rejects the weak password %s',
    async (password) => {
      await expectRejected({ ...validBody, password }, PASSWORD_POLICY_MESSAGE);
    },
  );
});

describe('createResident: barangay staff scope', () => {
  const body = {
    firstName: 'Juan',
    lastName: 'Cruz',
    email: 'juan@example.com',
    barangay: 'Other Barangay',
    birthDate: '2000-06-15',
  };

  it('forces staff to create residents in their own barangay', async () => {
    await run(createResident, { user: staff(), body });
    expect(callFor('INSERT INTO resident_accounts')[1][5]).toBe('Balanti');
  });

  it('lets an admin choose any barangay', async () => {
    await run(createResident, { user: admin, body });
    expect(callFor('INSERT INTO resident_accounts')[1][5]).toBe('Other Barangay');
  });

  it('lets staff with view-all choose any barangay', async () => {
    await run(createResident, {
      user: staff({ permissions: ['residents:view_all'] }),
      body,
    });
    expect(callFor('INSERT INTO resident_accounts')[1][5]).toBe('Other Barangay');
  });
});

// ---------- updateResident (FR5) ----------

describe('updateResident', () => {
  const ID = { id: '12' };

  // What the update saves when nothing in the body changes anything.
  const BASE = [
    'Juan',
    null,
    'Cruz',
    'juan@example.com',
    '09171234567',
    'Balanti',
    'Purok 1',
    '123 Rizal St',
    '2000-06-15',
    26,
    'Male',
    'Single',
    'Filipino',
    'Household Head',
    'Verified',
    'Active',
    'Active',
  ];

  it('returns 404 when the resident does not exist', async () => {
    setupDb({ resident: null });

    const { res, next } = await run(updateResident, { params: ID, body: {} });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident not found' });
    expect(next).not.toHaveBeenCalled();
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('blocks staff from editing a resident in another barangay', async () => {
    setupDb({ resident: residentRow({ barangay: 'Other' }) });

    const { res } = await run(updateResident, {
      user: staff(),
      params: ID,
      body: { firstName: 'Hijacked' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You can only manage residents in your assigned barangay',
    });
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('checks access before validating the new values', async () => {
    setupDb({ resident: residentRow({ barangay: 'Other' }) });

    const { res, next } = await run(updateResident, {
      user: staff(),
      params: ID,
      body: { gender: 'Nonsense' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps every value when nothing is sent', async () => {
    await run(updateResident, { params: ID, body: {} });

    const [sql, params] = callFor('UPDATE resident_accounts');
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual([...BASE, '12']);
  });

  it('changes only what was sent', async () => {
    await run(updateResident, {
      params: ID,
      body: { firstName: 'Pedro', contactNumber: '09999999999' },
    });

    const params = callFor('UPDATE resident_accounts')[1];
    expect(params[0]).toBe('Pedro');
    expect(params[4]).toBe('09999999999');
    expect(params[2]).toBe('Cruz');
    expect(params[3]).toBe('juan@example.com');
  });

  it('recalculates the age when the birthdate changes', async () => {
    await run(updateResident, { params: ID, body: { birthDate: '1990-01-01' } });

    const params = callFor('UPDATE resident_accounts')[1];
    expect(params[8]).toBe('1990-01-01');
    expect(params[9]).toBe(36);
  });

  it('responds with the resident', async () => {
    const { res, next } = await run(updateResident, { params: ID, body: {} });

    expect(next).not.toHaveBeenCalled();
    expect(dataOf(res)).toMatchObject({ rawId: 12, name: 'Juan Cruz' });
  });

  it('leaves the password alone when none is sent', async () => {
    await run(updateResident, { params: ID, body: {} });

    expect(callFor('UPDATE resident_accounts')[0]).not.toContain('password_hash');
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('saves a new hashed password', async () => {
    await run(updateResident, { params: ID, body: { password: 'NewPass123' } });

    const [sql, params] = callFor('UPDATE resident_accounts');
    expect(hashPassword).toHaveBeenCalledWith('NewPass123');
    expect(sql).toContain(', password_hash = ?');
    expect(params).toEqual([...BASE, 'hashed', '12']);
  });

  it('saves a new selfie with ID file', async () => {
    await run(updateResident, {
      params: ID,
      body: {},
      file: { path: 'uploads/new.jpg' },
    });

    const [sql, params] = callFor('UPDATE resident_accounts');
    expect(sql).toContain(', selfie_id_image = ?');
    expect(params).toEqual([...BASE, 'uploads/new.jpg', '12']);
  });

  it('saves the password and the selfie together in the right order', async () => {
    await run(updateResident, {
      params: ID,
      body: { password: 'NewPass123' },
      file: { path: 'uploads/new.jpg' },
    });

    expect(callFor('UPDATE resident_accounts')[1]).toEqual([
      ...BASE,
      'hashed',
      'uploads/new.jpg',
      '12',
    ]);
  });

  it('rejects a weak password and saves nothing', async () => {
    const { next } = await run(updateResident, {
      params: ID,
      body: { password: 'weak' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toBe(PASSWORD_POLICY_MESSAGE);
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('rejects invalid values and saves nothing', async () => {
    const gender = await run(updateResident, { params: ID, body: { gender: 'Nonsense' } });
    expect(gender.next.mock.calls[0][0].message).toBe('Invalid resident gender');

    const birth = await run(updateResident, { params: ID, body: { birthDate: '2030-01-01' } });
    expect(birth.next.mock.calls[0][0].message).toBe(
      'Birthdate must produce a valid resident age',
    );

    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('forces the account to inactive when verification is not Verified', async () => {
    await run(updateResident, {
      params: ID,
      body: { verificationStatus: 'Pending', accountStatus: 'Active' },
    });

    const params = callFor('UPDATE resident_accounts')[1];
    expect(params.slice(14, 17)).toEqual(['Pending', 'Inactive', 'Pending']);
  });

  it('forces staff to keep the resident in their own barangay', async () => {
    await run(updateResident, {
      user: staff(),
      params: ID,
      body: { barangay: 'Other Barangay' },
    });

    expect(callFor('UPDATE resident_accounts')[1][5]).toBe('Balanti');
  });

  it('lets an admin move a resident to another barangay', async () => {
    await run(updateResident, { params: ID, body: { barangay: 'San Nicolas' } });
    expect(callFor('UPDATE resident_accounts')[1][5]).toBe('San Nicolas');
  });

  it('records an audit entry that never contains the password', async () => {
    await run(updateResident, { params: ID, body: { password: 'NewPass123' } });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'residents.update',
        entityType: 'resident_accounts',
        entityId: '12',
      }),
    );
    const { details } = logAudit.mock.calls[0][0];
    expect(details.password).toBe('changed');
    expect(JSON.stringify(details)).not.toContain('NewPass123');
  });

  it('notes in the audit entry when the password was not changed', async () => {
    await run(updateResident, { params: ID, body: {} });

    const { details } = logAudit.mock.calls[0][0];
    expect(details.password).toBe('unchanged');
    expect(details.selfieIdChanged).toBe(false);
  });

  it('sends realtime events', async () => {
    await run(updateResident, { params: ID, body: {} });

    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'residents:changed',
      expect.objectContaining({ action: 'updated' }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'resident-updated',
    });
  });

  it('returns 409 for an email that is already registered', async () => {
    setupDb({ updateError: duplicateError() });

    const { res } = await run(updateResident, {
      params: ID,
      body: { email: 'taken@example.com' },
    });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'A resident account already exists for this email',
    });
  });

  it('passes other database errors to next', async () => {
    setupDb({ updateError: new Error('Database is down') });

    const { res, next } = await run(updateResident, { params: ID, body: {} });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ---------- the resident's own profile ----------

describe('getMyResidentProfile', () => {
  it('returns 403 for anyone who is not a resident', async () => {
    const { res } = await run(getMyResidentProfile, {
      user: { id: 1, role: 'admin', accountType: 'staff' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Only residents can access this profile',
    });
  });

  it('does not query the database for non-residents', async () => {
    await run(getMyResidentProfile, {
      user: { id: 1, role: 'admin', accountType: 'staff' },
    });
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('returns the signed-in resident\'s own profile', async () => {
    const { res } = await run(getMyResidentProfile, { user: residentUser });

    expect(callFor('WHERE ra.id = ?')[1]).toEqual([12]);
    expect(dataOf(res)).toMatchObject({ rawId: 12, name: 'Juan Cruz' });
  });

  it('returns 404 when the profile does not exist', async () => {
    setupDb({ resident: null });

    const { res } = await run(getMyResidentProfile, { user: residentUser });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident profile not found' });
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { next } = await run(getMyResidentProfile, { user: residentUser });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
  });
});

describe('updateMyResidentProfile', () => {
  it('returns 403 for anyone who is not a resident', async () => {
    const { res } = await run(updateMyResidentProfile, {
      user: { id: 1, role: 'admin', accountType: 'staff' },
      body: { firstName: 'X' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Only residents can update this profile',
    });
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('returns 404 when the profile does not exist', async () => {
    setupDb({ resident: null });

    const { res } = await run(updateMyResidentProfile, {
      user: residentUser,
      body: {},
    });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('saves the profile fields for the signed-in resident only', async () => {
    await run(updateMyResidentProfile, {
      user: residentUser,
      body: { firstName: 'Pedro', contactNumber: '09999999999' },
    });

    expect(callFor('UPDATE resident_accounts')[1]).toEqual([
      'Pedro',
      null,
      'Cruz',
      '09999999999',
      'Purok 1',
      '123 Rizal St',
      '2000-06-15',
      26,
      'Male',
      'Single',
      'Filipino',
      'Household Head',
      12,
    ]);
  });

  it('cannot change the email, barangay, or verification status', async () => {
    setupDb({ resident: pendingRow() });

    await run(updateMyResidentProfile, {
      user: residentUser,
      body: {
        email: 'hacker@example.com',
        barangay: 'Other',
        verificationStatus: 'Verified',
        accountStatus: 'Active',
      },
    });

    const [sql] = callFor('UPDATE resident_accounts');
    expect(sql).not.toContain('email');
    expect(sql).not.toContain('barangay');
    expect(sql).not.toContain('verification_status');
    expect(sql).not.toContain('account_status');
    expect(sql).not.toMatch(/\bstatus\b/);
  });

  it('ignores a password sent in the body', async () => {
    await run(updateMyResidentProfile, {
      user: residentUser,
      body: { password: 'NewPass123' },
    });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(callFor('UPDATE resident_accounts')[0]).not.toContain('password');
  });

  it('rejects invalid values and saves nothing', async () => {
    const { next } = await run(updateMyResidentProfile, {
      user: residentUser,
      body: { gender: 'Nonsense' },
    });

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(next.mock.calls[0][0].message).toBe('Invalid resident gender');
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
  });

  it('rejects a future birthdate', async () => {
    const { next } = await run(updateMyResidentProfile, {
      user: residentUser,
      body: { birthDate: '2030-01-01' },
    });

    expect(next.mock.calls[0][0].message).toBe(
      'Birthdate must produce a valid resident age',
    );
  });

  it('records an audit entry and sends a realtime event', async () => {
    await run(updateMyResidentProfile, {
      user: residentUser,
      body: { firstName: 'Pedro' },
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'profile.update',
        entityType: 'resident_accounts',
        entityId: 12,
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'residents:changed',
      expect.objectContaining({ action: 'profile-updated' }),
    );
  });

  it('responds with the profile', async () => {
    const { res } = await run(updateMyResidentProfile, {
      user: residentUser,
      body: {},
    });
    expect(dataOf(res)).toMatchObject({ rawId: 12 });
  });
});

// ---------- verification workflow ----------

describe('updateResidentStatus: choosing a status', () => {
  const ID = { id: '12' };

  const update = (body, req = {}) =>
    run(updateResidentStatus, { params: ID, body, ...req });

  const statusParams = () =>
    callFor('UPDATE resident_accounts SET verification_status')[1];

  it('verifies and activates a pending resident', async () => {
    setupDb({ resident: pendingRow() });

    const { res } = await update({
      verificationStatus: 'Verified',
      accountStatus: 'Active',
    });

    expect(statusParams()).toEqual(['Verified', 'Active', 'Active', '12']);
    expect(dataOf(res)).toMatchObject({ rawId: 12 });
  });

  it.each(['Pending', 'Needs Correction', 'Rejected'])(
    'forces the account to inactive when the status becomes %s',
    async (verificationStatus) => {
      await update({ verificationStatus });
      expect(statusParams()).toEqual([
        verificationStatus,
        'Inactive',
        verificationStatus,
        '12',
      ]);
    },
  );

  it('deactivates a verified resident', async () => {
    await update({ accountStatus: 'Inactive' });
    expect(statusParams()).toEqual(['Verified', 'Inactive', 'Inactive', '12']);
  });

  it('reactivates a verified resident', async () => {
    setupDb({ resident: residentRow({ account_status: 'Inactive', status: 'Inactive' }) });

    await update({ accountStatus: 'Active' });

    expect(statusParams()).toEqual(['Verified', 'Active', 'Active', '12']);
  });

  it('accepts the older status field for an account change', async () => {
    await update({ status: 'Inactive' });
    expect(statusParams()).toEqual(['Verified', 'Inactive', 'Inactive', '12']);
  });

  it('accepts the older status field for a verification change', async () => {
    await update({ status: 'Rejected' });
    expect(statusParams()).toEqual(['Rejected', 'Inactive', 'Rejected', '12']);
  });

  it('keeps the update query safe', async () => {
    await update({ verificationStatus: 'Rejected', reason: "x'; DROP TABLE y;--" });

    const [sql] = callFor('UPDATE resident_accounts SET verification_status');
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('Rejected');
  });
});

describe('updateResidentStatus: rejected requests', () => {
  const ID = { id: '12' };

  const update = (body, req = {}) =>
    run(updateResidentStatus, { params: ID, body, ...req });

  const expectNothingChanged = () => {
    expect(callFor('UPDATE resident_accounts')).toBeUndefined();
    expect(sendAccountStatusEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(emitRealtimeEvent).not.toHaveBeenCalled();
  };

  it.each([{}, { status: 'Banana' }, { status: '' }, { reason: 'No status' }])(
    'rejects the empty request %j with 400',
    async (body) => {
      const { res } = await update(body);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid resident status update' });
      expect(pool.execute).not.toHaveBeenCalled();
      expectNothingChanged();
    },
  );

  it('returns 404 when the resident does not exist', async () => {
    setupDb({ resident: null });

    const { res } = await update({ verificationStatus: 'Verified' });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident not found' });
    expectNothingChanged();
  });

  it('returns 404 when the update affects no rows', async () => {
    setupDb({ affectedRows: 0 });

    const { res } = await update({ verificationStatus: 'Verified' });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident not found' });
    expect(sendAccountStatusEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('blocks staff from verifying a resident in another barangay', async () => {
    setupDb({ resident: pendingRow({ barangay: 'Other' }) });

    const { res } = await update({ verificationStatus: 'Verified' }, { user: staff() });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You can only verify residents in your assigned barangay',
    });
    expectNothingChanged();
  });

  it('lets staff verify a resident in their own barangay', async () => {
    setupDb({ resident: pendingRow() });

    const { res } = await update(
      { verificationStatus: 'Verified', accountStatus: 'Active' },
      { user: staff() },
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown verification status', async () => {
    const { res } = await update({ verificationStatus: 'Banana' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Invalid resident verification status',
    });
    expectNothingChanged();
  });

  it('rejects an unknown account status', async () => {
    const { res } = await update({ accountStatus: 'Frozen' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid resident account status' });
    expectNothingChanged();
  });

  it('will not activate or deactivate a resident who is not verified', async () => {
    setupDb({ resident: pendingRow() });

    const { res } = await update({ accountStatus: 'Active' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Only verified residents can be activated or deactivated',
    });
    expectNothingChanged();
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await update({ verificationStatus: 'Verified' });

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('updateResidentStatus: telling the resident', () => {
  const ID = { id: '12' };

  const update = (body, req = {}) =>
    run(updateResidentStatus, { params: ID, body, ...req });

  const notification = () => callFor('INSERT INTO notifications');

  it.each([
    [
      { verificationStatus: 'Verified', accountStatus: 'Active' },
      'Your resident account has been approved. You can now sign in to CommUnity.',
    ],
    [
      { verificationStatus: 'Needs Correction' },
      'Your resident account needs correction before approval.',
    ],
    [
      { verificationStatus: 'Needs Correction', reason: 'Blurry ID' },
      'Your resident account needs correction before approval. Reason: Blurry ID',
    ],
    [
      { verificationStatus: 'Rejected' },
      'Your resident account registration was rejected.',
    ],
    [
      { verificationStatus: 'Rejected', reason: 'Fake ID' },
      'Your resident account registration was rejected. Reason: Fake ID',
    ],
    [
      { accountStatus: 'Inactive' },
      'Your resident account is now Inactive.',
    ],
    [
      { verificationStatus: 'Pending' },
      'Your resident verification status is now Pending.',
    ],
  ])('sends the right notification for %j', async (body, message) => {
    await update(body);

    expect(notification()[0]).toContain('?');
    expect(notification()[1]).toEqual([
      12,
      'Resident verification updated',
      message,
    ]);
  });

  it('sends a realtime notification event for the resident', async () => {
    await update({ verificationStatus: 'Rejected' });

    expect(emitRealtimeEvent).toHaveBeenCalledWith('notifications:changed', {
      action: 'created',
      userId: 12,
      userRole: 'resident',
    });
  });

  it('emails the resident about a verification change', async () => {
    await update({ verificationStatus: 'Rejected', reason: 'Fake ID' });

    expect(sendAccountStatusEmail).toHaveBeenCalledTimes(1);
    expect(sendAccountStatusEmail).toHaveBeenCalledWith({
      to: 'juan@example.com',
      name: 'Juan Cruz',
      status: 'Rejected',
      reason: 'Fake ID',
    });
  });

  it('emails the account status when only the account changed', async () => {
    await update({ accountStatus: 'Inactive' });

    expect(sendAccountStatusEmail).toHaveBeenCalledWith({
      to: 'juan@example.com',
      name: 'Juan Cruz',
      status: 'Inactive',
      reason: '',
    });
  });

  it('still succeeds when the email fails to send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendAccountStatusEmail.mockRejectedValue(new Error('SMTP down'));

    const { res, next } = await update({ verificationStatus: 'Rejected' });
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to send resident status email to juan@example.com: SMTP down',
    );

    errorSpy.mockRestore();
  });

  it('records an audit entry and sends realtime events', async () => {
    await update({ verificationStatus: 'Rejected', reason: 'Fake ID' });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'residents.status_update',
        entityType: 'resident_accounts',
        entityId: '12',
        details: {
          verificationStatus: 'Rejected',
          accountStatus: 'Inactive',
          reason: 'Fake ID',
        },
      }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith(
      'residents:changed',
      expect.objectContaining({ action: 'status-updated' }),
    );
    expect(emitRealtimeEvent).toHaveBeenCalledWith('dashboard:changed', {
      reason: 'resident-status-updated',
    });
  });
});

// ---------- selfie with ID download ----------

describe('getResidentSelfieId', () => {
  const ID = { id: '12' };
  const selfieRow = (overrides = {}) => ({
    barangay: 'Balanti',
    selfie_id_image: 'uploads/selfie.jpg',
    ...overrides,
  });

  beforeEach(() => {
    setupDb({ selfie: selfieRow() });
    fs.existsSync.mockReturnValue(true);
  });

  const fetchSelfie = (req = {}) =>
    run(getResidentSelfieId, { params: ID, ...req });

  it('sends the file for an admin', async () => {
    const { res, next } = await fetchSelfie();

    expect(next).not.toHaveBeenCalled();
    expect(res.sendFile).toHaveBeenCalledWith(path.resolve('uploads/selfie.jpg'));
  });

  it('looks the resident up with a safe query', async () => {
    await fetchSelfie();

    const [sql, params] = callFor('selfie_id_image FROM resident_accounts');
    expect(sql).toContain('?');
    expect(params).toEqual(['12']);
  });

  it('checks the file exists at the full path', async () => {
    await fetchSelfie();
    expect(fs.existsSync).toHaveBeenCalledWith(path.resolve('uploads/selfie.jpg'));
  });

  it('uses an absolute path as it is', async () => {
    const absolute = path.resolve('uploads', 'absolute.jpg');
    setupDb({ selfie: selfieRow({ selfie_id_image: absolute }) });

    const { res } = await fetchSelfie();

    expect(res.sendFile).toHaveBeenCalledWith(absolute);
  });

  it('returns 404 when the resident does not exist', async () => {
    setupDb({ selfie: null });

    const { res } = await fetchSelfie();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Resident not found' });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('returns 404 when no selfie was uploaded', async () => {
    setupDb({ selfie: selfieRow({ selfie_id_image: null }) });

    const { res } = await fetchSelfie();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Resident has no uploaded selfie with ID',
    });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the file is missing from disk', async () => {
    fs.existsSync.mockReturnValue(false);

    const { res } = await fetchSelfie();

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Uploaded selfie with ID file was not found on disk',
    });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('blocks staff from another barangay', async () => {
    setupDb({ selfie: selfieRow({ barangay: 'Other' }) });

    const { res } = await fetchSelfie({ user: staff() });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'You can only view resident documents in your assigned barangay',
    });
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('does not check the disk before the access check passes', async () => {
    setupDb({ selfie: selfieRow({ barangay: 'Other' }) });

    await fetchSelfie({ user: staff() });

    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('lets staff view a selfie in their own barangay', async () => {
    const { res } = await fetchSelfie({ user: staff() });
    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('lets staff with view-all see another barangay', async () => {
    setupDb({ selfie: selfieRow({ barangay: 'Other' }) });

    const { res } = await fetchSelfie({
      user: staff({ permissions: ['residents:view_all'] }),
    });

    expect(res.sendFile).toHaveBeenCalledTimes(1);
  });

  it('passes database errors to next', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await fetchSelfie();

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.sendFile).not.toHaveBeenCalled();
  });
});