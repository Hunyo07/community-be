import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';

// Replace the database and the name formatter with fakes before the controller loads.
vi.mock('../src/config/db.js', () => ({
  pool: { execute: vi.fn() },
}));
vi.mock('../src/utils/residentName.js', () => ({
  formatResidentName: (first, middle, last) =>
    [first, middle, last].filter(Boolean).join(' '),
}));

import { pool } from '../src/config/db.js';
import { getReport } from '../src/controllers/reportController.js';

// Freeze "today" at June 15, 2026 so ages in the reports are the same on any day.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------- helpers ----------

// Builds a fake Express response.
const createRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const admin = { id: 1, role: 'admin', permissions: [] };

const staff = (overrides = {}) => ({
  id: 2,
  role: 'barangay_staff',
  barangay: 'Balanti',
  officeId: 2,
  permissions: [],
  ...overrides,
});

// Runs getReport and returns the response pieces.
const run = async (type, query = {}, user = admin) => {
  const res = createRes();
  const next = vi.fn();
  await getReport({ params: { type }, query, user }, res, next);
  const body = res.json.mock.calls[0]?.[0];
  return { res, next, body, data: body?.data };
};

// Makes every database query answer with these rows.
const setRows = (rows) => pool.execute.mockResolvedValue([rows]);

// The barangays report runs three queries in a row: barangays, residents, requests.
const setBarangayData = ({ barangays = [], residents = [], requests = [] } = {}) => {
  pool.execute.mockReset();
  pool.execute
    .mockResolvedValueOnce([barangays])
    .mockResolvedValueOnce([residents])
    .mockResolvedValueOnce([requests]);
};

const firstCall = () => pool.execute.mock.calls[0];

const residentRow = (overrides = {}) => ({
  id: 12,
  first_name: 'Juan',
  middle_name: null,
  last_name: 'Cruz',
  barangay: 'Balanti',
  purok_sitio: 'Purok 1',
  street_address: '123 Rizal St',
  contact_number: '09171234567',
  email: 'juan@example.com',
  birth_date: '2000-06-15',
  gender: 'Male',
  age: 26,
  civil_status: 'Single',
  nationality: 'Filipino',
  household_status: 'Household Head',
  verification_status: 'Verified',
  account_status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  served_programs: 0,
  ...overrides,
});

const requestRow = (overrides = {}) => ({
  id: 7,
  status: 'Submitted',
  created_at: '2026-02-01T00:00:00.000Z',
  resident_name: 'Juan Cruz',
  barangay: 'Balanti',
  document_type_name: 'Barangay Clearance',
  ...overrides,
});

const serviceRow = (overrides = {}) => ({
  id: 5,
  name: 'Free Medical Checkup',
  category: 'Health',
  barangay: 'Balanti',
  office_name: null,
  target_beneficiaries: 100,
  served_count: 25,
  target_residents: 100,
  status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const beneficiaryRow = (overrides = {}) => ({
  service_id: 5,
  service_name: 'Free Medical Checkup',
  resident_id: 12,
  first_name: 'Juan',
  middle_name: null,
  last_name: 'Cruz',
  barangay: 'Balanti',
  purok_sitio: 'Purok 1',
  beneficiary_status: 'Served',
  served_at: '2026-02-03T00:00:00.000Z',
  ...overrides,
});

const staffRow = (overrides = {}) => ({
  id: 3,
  name: 'Sam Staff',
  email: 'sam@example.com',
  role: 'barangay_staff',
  barangay: 'Balanti',
  office_name: 'Health Office',
  status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const officeRow = (overrides = {}) => ({
  id: 1,
  name: 'Health Office',
  barangay: 'Balanti',
  description: 'Handles health programs',
  status: 'Active',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  pool.execute.mockReset();
  pool.execute.mockResolvedValue([[]]);
});

// ---------- the report endpoint itself ----------

describe('getReport: choosing a report', () => {
  it.each([
    ['residents', 'Resident Report'],
    ['requests', 'Document Request Report'],
    ['services', 'Service Report'],
    ['beneficiaries', 'Service Beneficiary Report'],
    ['barangays', 'Barangay Performance Report'],
    ['staff', 'Staff Report'],
    ['offices', 'Office Report'],
  ])('builds the %s report with the title "%s"', async (type, title) => {
    const { data, next } = await run(type);

    expect(next).not.toHaveBeenCalled();
    expect(data.type).toBe(type);
    expect(data.title).toBe(title);
  });

  it.each(['nope', 'resident', 'RESIDENTS', '', undefined])(
    'rejects the unknown type %s with 400',
    async (type) => {
      const { res } = await run(type);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Unknown report type' });
      expect(pool.execute).not.toHaveBeenCalled();
    },
  );

  it('ignores spaces around the type', async () => {
    const { data } = await run(' residents ');
    expect(data.type).toBe('residents');
  });

  it('responds with the full report shape', async () => {
    const { data } = await run('residents');

    expect(Object.keys(data).sort()).toEqual(
      ['columns', 'filters', 'generatedAt', 'rows', 'summary', 'title', 'type'].sort(),
    );
    expect(Array.isArray(data.columns)).toBe(true);
    expect(Array.isArray(data.rows)).toBe(true);
    expect(Array.isArray(data.summary)).toBe(true);
  });

  it('stamps the time the report was generated', async () => {
    const { data } = await run('residents');
    expect(data.generatedAt).toBe(new Date().toISOString());
  });

  it('returns an empty table (not an error) when nothing matches', async () => {
    const { data, next } = await run('residents');

    expect(next).not.toHaveBeenCalled();
    expect(data.rows).toEqual([]);
    expect(data.summary[0]).toEqual({ label: 'Total residents', value: '0' });
  });

  it('passes database errors to next and sends no response', async () => {
    pool.execute.mockRejectedValue(new Error('Database is down'));

    const { res, next } = await run('residents');

    expect(next.mock.calls[0][0].message).toBe('Database is down');
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('getReport: reading filters', () => {
  it('returns empty filters when none are given', async () => {
    const { data } = await run('residents');

    expect(data.filters).toEqual({
      from: '',
      to: '',
      barangay: '',
      verificationStatus: '',
      accountStatus: '',
      status: '',
      documentTypeId: '',
      category: '',
      serviceId: '',
      beneficiaryStatus: '',
      role: '',
    });
  });

  it('keeps valid dates', async () => {
    const { data } = await run('residents', { from: '2026-01-01', to: '2026-01-31' });

    expect(data.filters.from).toBe('2026-01-01');
    expect(data.filters.to).toBe('2026-01-31');
  });

  it.each(['January', '2026-1-1', '01-01-2026', '2026/01/01', '2026-01-01T00:00', ' '])(
    'drops the badly formatted date %s',
    async (value) => {
      const { data } = await run('residents', { from: value, to: value });

      expect(data.filters.from).toBe('');
      expect(data.filters.to).toBe('');
    },
  );

  it('does not apply a badly formatted date to the query', async () => {
    await run('residents', { from: "2026-01-01'; DROP TABLE x;--" });
    expect(firstCall()[1]).toEqual([]);
  });

  it('trims spaces from text filters', async () => {
    const { data } = await run('residents', {
      barangay: '  Balanti  ',
      status: ' Active ',
    });

    expect(data.filters.barangay).toBe('Balanti');
    expect(data.filters.status).toBe('Active');
  });
});

// ---------- residents report (FR11) ----------

describe('residents report: rows', () => {
  it('maps a database row into a report row', async () => {
    setRows([residentRow()]);

    const { data } = await run('residents');

    expect(data.rows[0]).toEqual({
      id: 'RES-0012',
      name: 'Juan Cruz',
      birthDate: '2000-06-15',
      age: '26 years',
      gender: 'Male',
      civilStatus: 'Single',
      nationality: 'Filipino',
      barangay: 'Balanti',
      address: '123 Rizal St, Purok 1',
      contactNumber: '09171234567',
      householdStatus: 'Household Head',
      beneficiaryStatus: 'Not a beneficiary',
      verificationStatus: 'Verified',
      accountStatus: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([residentRow()]);

    const { data } = await run('residents');

    expect(data.columns).toHaveLength(15);
    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('works out a precise age from the birthdate', async () => {
    setRows([residentRow({ birth_date: '2001-02-28' })]);

    const { data } = await run('residents');

    expect(data.rows[0].age).toBe('25 years, 3 months, 2 weeks, 4 days');
  });

  it('reads a birthdate that arrives as a Date object', async () => {
    setRows([residentRow({ birth_date: new Date(2000, 5, 15) })]);

    const { data } = await run('residents');

    expect(data.rows[0].birthDate).toBe('2000-06-15');
    expect(data.rows[0].age).toBe('26 years');
  });

  it('falls back to the stored age when there is no birthdate', async () => {
    setRows([residentRow({ birth_date: null, age: 40 })]);

    const { data } = await run('residents');

    expect(data.rows[0].age).toBe(40);
  });

  it('shows an empty age when there is no birthdate and no stored age', async () => {
    setRows([residentRow({ birth_date: null, age: null })]);

    const { data } = await run('residents');

    expect(data.rows[0].age).toBe('');
  });

  it('fills in defaults for empty fields', async () => {
    setRows([
      residentRow({
        gender: null,
        civil_status: null,
        household_status: null,
        nationality: null,
        purok_sitio: null,
        street_address: null,
      }),
    ]);

    const { data } = await run('residents');

    expect(data.rows[0]).toMatchObject({
      gender: 'Unspecified',
      civilStatus: 'Unspecified',
      householdStatus: 'Unspecified',
      nationality: '',
      address: '',
    });
  });

  it('shows the email when there is no contact number', async () => {
    setRows([residentRow({ contact_number: null })]);

    const { data } = await run('residents');

    expect(data.rows[0].contactNumber).toBe('juan@example.com');
  });

  it('shows an empty contact when there is neither number nor email', async () => {
    setRows([residentRow({ contact_number: null, email: null })]);

    const { data } = await run('residents');

    expect(data.rows[0].contactNumber).toBe('');
  });

  it('describes beneficiaries by how many programs served them', async () => {
    setRows([
      residentRow({ id: 1, served_programs: 0 }),
      residentRow({ id: 2, served_programs: 1 }),
      residentRow({ id: 3, served_programs: 3 }),
    ]);

    const { data } = await run('residents');

    expect(data.rows.map((row) => row.beneficiaryStatus)).toEqual([
      'Not a beneficiary',
      'Beneficiary (1 program)',
      'Beneficiary (3 programs)',
    ]);
  });
});

describe('residents report: summary', () => {
  it('counts residents by verification status and beneficiaries', async () => {
    setRows([
      residentRow({ id: 1, verification_status: 'Verified', served_programs: 2 }),
      residentRow({ id: 2, verification_status: 'Verified', served_programs: 0 }),
      residentRow({ id: 3, verification_status: 'Pending', served_programs: 1 }),
      residentRow({ id: 4, verification_status: 'Rejected', served_programs: 0 }),
    ]);

    const { data } = await run('residents');

    expect(data.summary).toEqual([
      { label: 'Total residents', value: '4' },
      { label: 'Verified', value: '2' },
      { label: 'Pending', value: '1' },
      { label: 'Rejected', value: '1' },
      { label: 'Beneficiaries', value: '2' },
    ]);
  });

  it('adds thousands separators to large counts', async () => {
    setRows(Array.from({ length: 1200 }, (_, i) => residentRow({ id: i + 1 })));

    const { data } = await run('residents');

    expect(data.summary[0]).toEqual({ label: 'Total residents', value: '1,200' });
  });
});

describe('residents report: filters and date range', () => {
  it('adds no filters when none are given', async () => {
    await run('residents');

    const [sql, params] = firstCall();
    expect(params).toEqual([]);
    expect(sql).not.toContain('ra.barangay = ?');
  });

  it('filters by barangay, verification, and account status in order', async () => {
    await run('residents', {
      barangay: 'Balanti',
      verificationStatus: 'Pending',
      accountStatus: 'Active',
    });

    const [sql, params] = firstCall();
    expect(sql).toContain('ra.barangay = ?');
    expect(sql).toContain('ra.verification_status = ?');
    expect(sql).toContain('ra.account_status = ?');
    expect(params).toEqual(['Balanti', 'Pending', 'Active']);
  });

  it('filters by a date range on the registration date', async () => {
    await run('residents', { from: '2026-01-01', to: '2026-01-31' });

    const [sql, params] = firstCall();
    expect(sql).toContain('DATE(ra.created_at) >= ?');
    expect(sql).toContain('DATE(ra.created_at) <= ?');
    expect(params).toEqual(['2026-01-01', '2026-01-31']);
  });

  it('supports a start date only', async () => {
    await run('residents', { from: '2026-01-01' });

    const [sql, params] = firstCall();
    expect(sql).toContain('DATE(ra.created_at) >= ?');
    expect(sql).not.toContain('DATE(ra.created_at) <= ?');
    expect(params).toEqual(['2026-01-01']);
  });

  it('supports an end date only', async () => {
    await run('residents', { to: '2026-01-31' });

    const [sql, params] = firstCall();
    expect(sql).not.toContain('DATE(ra.created_at) >= ?');
    expect(sql).toContain('DATE(ra.created_at) <= ?');
    expect(params).toEqual(['2026-01-31']);
  });

  it('combines every filter in order', async () => {
    await run('residents', {
      barangay: 'Balanti',
      verificationStatus: 'Verified',
      accountStatus: 'Active',
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(firstCall()[1]).toEqual([
      'Balanti',
      'Verified',
      'Active',
      '2026-01-01',
      '2026-01-31',
    ]);
  });

  it('keeps filter text out of the SQL', async () => {
    const attack = "x'; DROP TABLE resident_accounts;--";
    await run('residents', { barangay: attack });

    const [sql, params] = firstCall();
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toEqual([attack]);
  });
});

describe('residents report: who can see which barangay', () => {
  it('lets an admin choose any barangay', async () => {
    await run('residents', { barangay: 'Other' });
    expect(firstCall()[1]).toEqual(['Other']);
  });

  it('forces staff to their own barangay', async () => {
    await run('residents', {}, staff());
    expect(firstCall()[1]).toEqual(['Balanti']);
  });

  it('keeps staff in their barangay even when asking for another', async () => {
    await run('residents', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti']);
  });

  it('lets staff with the view-all permission choose a barangay', async () => {
    await run(
      'residents',
      { barangay: 'Other' },
      staff({ permissions: ['residents:view_all'] }),
    );
    expect(firstCall()[1]).toEqual(['Other']);
  });

  it('shows every barangay to staff with view-all who do not choose one', async () => {
    await run('residents', {}, staff({ permissions: ['residents:view_all'] }));
    expect(firstCall()[1]).toEqual([]);
  });

  it('does not let a resident account see all barangays by asking', async () => {
    await run('residents', { barangay: 'Other' }, { role: 'resident', barangay: 'Balanti' });
    expect(firstCall()[1]).toEqual(['Other']);
  });
});

// ---------- document requests report ----------

describe('requests report: rows', () => {
  it('maps a database row into a report row', async () => {
    setRows([requestRow()]);

    const { data } = await run('requests');

    expect(data.rows[0]).toEqual({
      id: 'REQ-0007',
      residentName: 'Juan Cruz',
      barangay: 'Balanti',
      documentTypeName: 'Barangay Clearance',
      status: 'Submitted',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([requestRow()]);

    const { data } = await run('requests');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('shows "Completed" requests as "Ready to Claim"', async () => {
    setRows([requestRow({ status: 'Completed' })]);

    const { data } = await run('requests');

    expect(data.rows[0].status).toBe('Ready to Claim');
  });

  it.each(['Submitted', 'Under Review', 'Approved', 'Processing', 'Claimed', 'Rejected'])(
    'keeps the status %s unchanged',
    async (status) => {
      setRows([requestRow({ status })]);

      const { data } = await run('requests');

      expect(data.rows[0].status).toBe(status);
    },
  );

  it('fills in defaults for missing names', async () => {
    setRows([
      requestRow({ resident_name: null, barangay: null, document_type_name: null }),
    ]);

    const { data } = await run('requests');

    expect(data.rows[0]).toMatchObject({
      residentName: 'Resident',
      barangay: '',
      documentTypeName: 'Document',
    });
  });
});

describe('requests report: summary', () => {
  it('counts open and completed requests', async () => {
    setRows([
      requestRow({ id: 1, status: 'Submitted' }),
      requestRow({ id: 2, status: 'Under Review' }),
      requestRow({ id: 3, status: 'Approved' }),
      requestRow({ id: 4, status: 'Processing' }),
      requestRow({ id: 5, status: 'Completed' }),
      requestRow({ id: 6, status: 'Claimed' }),
      requestRow({ id: 7, status: 'Rejected' }),
    ]);

    const { data } = await run('requests');

    expect(data.summary).toEqual([
      { label: 'Total requests', value: '7' },
      { label: 'Open', value: '4' },
      { label: 'Completed / claimed', value: '2' },
    ]);
  });
});

describe('requests report: filters and date range', () => {
  it('adds no filters for an admin who asks for none', async () => {
    await run('requests');
    expect(firstCall()[1]).toEqual([]);
  });

  it('filters by barangay, status, document type, and dates in order', async () => {
    await run('requests', {
      barangay: 'Balanti',
      status: 'Approved',
      documentTypeId: '3',
      from: '2026-01-01',
      to: '2026-01-31',
    });

    const [sql, params] = firstCall();
    expect(sql).toContain('ra.barangay = ?');
    expect(sql).toContain('sr.status = ?');
    expect(sql).toContain('sr.document_type_id = ?');
    expect(sql).toContain('DATE(sr.created_at) >= ?');
    expect(sql).toContain('DATE(sr.created_at) <= ?');
    expect(params).toEqual(['Balanti', 'Approved', 3, '2026-01-01', '2026-01-31']);
  });

  it('turns the document type into a number', async () => {
    await run('requests', { documentTypeId: '12' });
    expect(firstCall()[1]).toEqual([12]);
  });

  it.each(['abc', '0', '-1', '2.5', ''])(
    'ignores the document type %s',
    async (value) => {
      await run('requests', { documentTypeId: value });
      expect(firstCall()[1]).toEqual([]);
    },
  );

  it('forces staff to their own barangay', async () => {
    await run('requests', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti']);
  });

  it('shows staff with view-all their own barangay when they pick none', async () => {
    await run('requests', {}, staff({ permissions: ['residents:view_all'] }));
    expect(firstCall()[1]).toEqual(['Balanti']);
  });

  it('lets staff with view-all pick another barangay', async () => {
    await run(
      'requests',
      { barangay: 'Other' },
      staff({ permissions: ['residents:view_all'] }),
    );
    expect(firstCall()[1]).toEqual(['Other']);
  });

  it('shows staff with no barangay nothing instead of everything', async () => {
    await run('requests', {}, staff({ barangay: undefined }));
    expect(firstCall()[1]).toEqual(['']);
  });
});

// ---------- services report (FR12) ----------

describe('services report: rows', () => {
  it('maps a database row into a report row', async () => {
    setRows([serviceRow()]);

    const { data } = await run('services');

    expect(data.rows[0]).toEqual({
      id: 'SRV-005',
      rawId: 5,
      name: 'Free Medical Checkup',
      category: 'Health',
      barangay: 'Balanti',
      officeName: '',
      target: 100,
      served: 25,
      remaining: 75,
      progress: '25%',
      status: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([serviceRow()]);

    const { data } = await run('services');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('shows the office name when there is one', async () => {
    setRows([serviceRow({ office_name: 'Health Office' })]);

    const { data } = await run('services');

    expect(data.rows[0].officeName).toBe('Health Office');
  });

  it('uses the stored target when the resident count is 0', async () => {
    setRows([serviceRow({ target_residents: 0, target_beneficiaries: 50, served_count: 10 })]);

    const { data } = await run('services');

    expect(data.rows[0]).toMatchObject({ target: 50, remaining: 40, progress: '20%' });
  });

  it('shows 0% progress when the target is 0', async () => {
    setRows([serviceRow({ target_residents: 0, target_beneficiaries: 0, served_count: 5 })]);

    const { data } = await run('services');

    expect(data.rows[0]).toMatchObject({ target: 0, remaining: 0, progress: '0%' });
  });

  it('never shows a negative remaining count', async () => {
    setRows([serviceRow({ served_count: 120, target_residents: 100 })]);

    const { data } = await run('services');

    expect(data.rows[0].remaining).toBe(0);
  });

  it('rounds progress to a whole number', async () => {
    setRows([serviceRow({ served_count: 1, target_residents: 3 })]);

    const { data } = await run('services');

    expect(data.rows[0].progress).toBe('33%');
  });

  it('reads counts that arrive as text', async () => {
    setRows([serviceRow({ served_count: '25', target_residents: '100' })]);

    const { data } = await run('services');

    expect(data.rows[0]).toMatchObject({ target: 100, served: 25, remaining: 75 });
  });
});

describe('services report: summary', () => {
  it('adds up services, served, and not yet served', async () => {
    setRows([
      serviceRow({ id: 1, served_count: 25, target_residents: 100 }),
      serviceRow({ id: 2, served_count: 50, target_residents: 100 }),
    ]);

    const { data } = await run('services');

    expect(data.summary).toEqual([
      { label: 'Services', value: '2' },
      { label: 'Served', value: '75' },
      { label: 'Not yet served', value: '125' },
    ]);
  });
});

describe('services report: filters and date range', () => {
  it('adds no filters for an admin who asks for none', async () => {
    await run('services');
    expect(firstCall()[1]).toEqual([]);
  });

  it('filters by barangay, category, and status in order', async () => {
    await run('services', { barangay: 'Balanti', category: 'Health', status: 'Active' });

    const [sql, params] = firstCall();
    expect(sql).toContain('services.barangay = ?');
    expect(sql).toContain('services.category = ?');
    expect(sql).toContain('services.status = ?');
    expect(params).toEqual(['Balanti', 'Health', 'Active']);
  });

  it('keeps services that were active during the date range', async () => {
    await run('services', { from: '2026-01-01', to: '2026-03-31' });

    const [sql, params] = firstCall();
    expect(sql).toContain('services.end_date IS NULL OR services.end_date >= ?');
    expect(sql).toContain('services.start_date IS NULL OR services.start_date <= ?');
    expect(params).toEqual(['2026-01-01', '2026-03-31']);
  });

  it('supports a start date only', async () => {
    await run('services', { from: '2026-01-01' });

    const [sql, params] = firstCall();
    expect(sql).toContain('services.end_date >= ?');
    expect(sql).not.toContain('services.start_date <= ?');
    expect(params).toEqual(['2026-01-01']);
  });

  it('combines every filter in order', async () => {
    await run('services', {
      barangay: 'Balanti',
      category: 'Health',
      status: 'Active',
      from: '2026-01-01',
      to: '2026-03-31',
    });

    expect(firstCall()[1]).toEqual([
      'Balanti',
      'Health',
      'Active',
      '2026-01-01',
      '2026-03-31',
    ]);
  });

  it('limits staff to their barangay and office', async () => {
    await run('services', {}, staff());

    const [sql, params] = firstCall();
    expect(sql).toContain('services.office_id IS NULL');
    expect(params).toEqual(['Balanti', 2]);
  });

  it('uses 0 as the office when staff have no office', async () => {
    await run('services', {}, staff({ officeId: null }));
    expect(firstCall()[1]).toEqual(['Balanti', 0]);
  });

  it('keeps staff in their barangay even when asking for another', async () => {
    await run('services', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti', 2]);
  });

  it('shows all offices in the barangay to staff with that permission', async () => {
    await run('services', {}, staff({ permissions: ['services:view_all_offices'] }));
    expect(firstCall()[1]).toEqual(['Balanti']);
  });

  it('shows every barangay and office to staff with the all-barangays permission', async () => {
    await run('services', {}, staff({ permissions: ['services:view_all_barangays'] }));
    expect(firstCall()[1]).toEqual([]);
  });

  it('lets staff with the all-barangays permission choose a barangay', async () => {
    await run(
      'services',
      { barangay: 'Other' },
      staff({ permissions: ['services:view_all_barangays'] }),
    );
    expect(firstCall()[1]).toEqual(['Other']);
  });
});

// ---------- beneficiaries report ----------

describe('beneficiaries report: rows', () => {
  it('maps a database row into a report row', async () => {
    setRows([beneficiaryRow()]);

    const { data } = await run('beneficiaries');

    expect(data.rows[0]).toEqual({
      id: '5-12',
      serviceName: 'Free Medical Checkup',
      residentName: 'Juan Cruz',
      barangay: 'Balanti',
      purokSitio: 'Purok 1',
      beneficiaryStatus: 'Served',
      dateServed: '2026-02-03T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([beneficiaryRow()]);

    const { data } = await run('beneficiaries');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('uses an empty purok when there is none', async () => {
    setRows([beneficiaryRow({ purok_sitio: null })]);

    const { data } = await run('beneficiaries');

    expect(data.rows[0].purokSitio).toBe('');
  });
});

describe('beneficiaries report: summary', () => {
  it('counts served, not served, and pending records', async () => {
    setRows([
      beneficiaryRow({ resident_id: 1, beneficiary_status: 'Served' }),
      beneficiaryRow({ resident_id: 2, beneficiary_status: 'Served' }),
      beneficiaryRow({ resident_id: 3, beneficiary_status: 'Not Served' }),
      beneficiaryRow({ resident_id: 4, beneficiary_status: 'Pending' }),
      beneficiaryRow({ resident_id: 5, beneficiary_status: 'Skipped' }),
    ]);

    const { data } = await run('beneficiaries');

    expect(data.summary).toEqual([
      { label: 'Records', value: '5' },
      { label: 'Served', value: '2' },
      { label: 'Not yet served', value: '1' },
      { label: 'Pending', value: '1' },
    ]);
  });
});

describe('beneficiaries report: filters and date range', () => {
  it('always limits Senior Citizen services to residents aged 60 and up', async () => {
    await run('beneficiaries');

    const [sql, params] = firstCall();
    expect(sql).toContain("services.target_scope != 'Senior Citizens' OR ra.age >= 60");
    expect(params).toEqual([]);
  });

  it('filters by one service', async () => {
    await run('beneficiaries', { serviceId: '5' });

    const [sql, params] = firstCall();
    expect(sql).toContain('services.id = ?');
    expect(params).toEqual([5]);
  });

  it.each(['abc', '0', '-2', '1.5', ''])(
    'ignores the service id %s',
    async (value) => {
      await run('beneficiaries', { serviceId: value });
      expect(firstCall()[1]).toEqual([]);
    },
  );

  it('"Not Served" finds residents with no record, with no extra values', async () => {
    await run('beneficiaries', { beneficiaryStatus: 'Not Served' });

    const [sql, params] = firstCall();
    expect(sql).toContain('sb.id IS NULL');
    expect(params).toEqual([]);
  });

  it('filters by a beneficiary status', async () => {
    await run('beneficiaries', { beneficiaryStatus: 'Pending' });

    const [sql, params] = firstCall();
    expect(sql).toContain('sb.status = ?');
    expect(params).toEqual(['Pending']);
  });

  it('dates the Served status by the day they were served', async () => {
    await run('beneficiaries', {
      beneficiaryStatus: 'Served',
      from: '2026-01-01',
      to: '2026-01-31',
    });

    const [sql, params] = firstCall();
    expect(sql).toContain('DATE(sb.served_at) >= ?');
    expect(sql).toContain('DATE(sb.served_at) <= ?');
    expect(params).toEqual(['Served', '2026-01-01', '2026-01-31']);
  });

  it('dates other statuses by the day the record was created', async () => {
    await run('beneficiaries', {
      beneficiaryStatus: 'Pending',
      from: '2026-01-01',
      to: '2026-01-31',
    });

    const [sql, params] = firstCall();
    expect(sql).toContain('DATE(sb.created_at) >= ?');
    expect(params).toEqual(['Pending', '2026-01-01', '2026-01-31']);
  });

  it('ignores the date range for "Not Served" because there is no record to date', async () => {
    await run('beneficiaries', {
      beneficiaryStatus: 'Not Served',
      from: '2026-01-01',
      to: '2026-01-31',
    });

    const [sql, params] = firstCall();
    expect(sql).not.toContain('DATE(sb.');
    expect(params).toEqual([]);
  });

  it('with no status, matches served and other records by their own dates, and keeps unserved residents', async () => {
    await run('beneficiaries', { from: '2026-01-01', to: '2026-01-31' });

    const [sql, params] = firstCall();
    expect(sql).toContain("sb.status = 'Served'");
    expect(sql).toContain("sb.status <> 'Served'");
    expect(sql).toContain('OR sb.id IS NULL');
    expect(params).toEqual(['2026-01-01', '2026-01-31', '2026-01-01', '2026-01-31']);
  });

  it('with no status and a start date only, passes it for both date checks', async () => {
    await run('beneficiaries', { from: '2026-01-01' });
    expect(firstCall()[1]).toEqual(['2026-01-01', '2026-01-01']);
  });

  it('combines every filter in order', async () => {
    await run('beneficiaries', {
      barangay: 'Balanti',
      serviceId: '5',
      beneficiaryStatus: 'Served',
      from: '2026-01-01',
    });

    expect(firstCall()[1]).toEqual(['Balanti', 5, 'Served', '2026-01-01']);
  });

  it('limits staff to their barangay and office', async () => {
    await run('beneficiaries', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti', 2]);
  });

  it('shows every barangay to staff with the all-barangays permission', async () => {
    await run('beneficiaries', {}, staff({ permissions: ['services:view_all_barangays'] }));
    expect(firstCall()[1]).toEqual([]);
  });
});

// ---------- barangays report ----------

describe('barangays report: rows', () => {
  it('combines barangays, resident counts, and request counts', async () => {
    setBarangayData({
      barangays: [{ name: 'Balanti' }, { name: 'San Nicolas' }],
      residents: [{ barangay: 'Balanti', residents: '10', verified: '5' }],
      requests: [{ barangay: 'Balanti', total_requests: '4', completed_requests: '2' }],
    });

    const { data } = await run('barangays');

    expect(data.rows).toEqual([
      {
        id: 'Balanti',
        barangay: 'Balanti',
        residents: 10,
        verified: 5,
        verificationPercent: '50%',
        requestsSubmitted: 4,
        requestsCompleted: 2,
      },
      {
        id: 'San Nicolas',
        barangay: 'San Nicolas',
        residents: 0,
        verified: 0,
        verificationPercent: '0%',
        requestsSubmitted: 0,
        requestsCompleted: 0,
      },
    ]);
  });

  it('has a value for every column', async () => {
    setBarangayData({ barangays: [{ name: 'Balanti' }] });

    const { data } = await run('barangays');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('runs three queries', async () => {
    setBarangayData({ barangays: [{ name: 'Balanti' }] });

    await run('barangays');

    expect(pool.execute).toHaveBeenCalledTimes(3);
  });

  it('rounds the verification percentage', async () => {
    setBarangayData({
      barangays: [{ name: 'Balanti' }],
      residents: [{ barangay: 'Balanti', residents: '3', verified: '1' }],
    });

    const { data } = await run('barangays');

    expect(data.rows[0].verificationPercent).toBe('33%');
  });
});

describe('barangays report: summary', () => {
  it('adds up residents and verification coverage', async () => {
    setBarangayData({
      barangays: [{ name: 'A' }, { name: 'B' }],
      residents: [
        { barangay: 'A', residents: '10', verified: '5' },
        { barangay: 'B', residents: '10', verified: '10' },
      ],
    });

    const { data } = await run('barangays');

    expect(data.summary).toEqual([
      { label: 'Barangays', value: '2' },
      { label: 'Residents', value: '20' },
      { label: 'Verified', value: '15' },
      { label: 'Verification coverage', value: '75%' },
    ]);
  });

  it('shows 0% coverage when there are no residents', async () => {
    setBarangayData({ barangays: [{ name: 'A' }] });

    const { data } = await run('barangays');

    expect(data.summary[3]).toEqual({ label: 'Verification coverage', value: '0%' });
  });
});

describe('barangays report: filters and date range', () => {
  it('asks for every barangay when none is chosen', async () => {
    setBarangayData();

    await run('barangays');

    const [barangaySql, barangayParams] = pool.execute.mock.calls[0];
    expect(barangaySql).toContain('FROM barangays');
    expect(barangaySql).not.toContain('WHERE name = ?');
    expect(barangayParams).toEqual([]);
    expect(pool.execute.mock.calls[1][1]).toEqual([]);
    expect(pool.execute.mock.calls[2][1]).toEqual([]);
  });

  it('applies the barangay and date range to all three queries', async () => {
    setBarangayData();

    await run('barangays', { barangay: 'Balanti', from: '2026-01-01', to: '2026-01-31' });

    expect(pool.execute.mock.calls[0][1]).toEqual(['Balanti']);
    expect(pool.execute.mock.calls[0][0]).toContain('WHERE name = ?');
    expect(pool.execute.mock.calls[1][1]).toEqual(['Balanti', '2026-01-01', '2026-01-31']);
    expect(pool.execute.mock.calls[2][1]).toEqual(['Balanti', '2026-01-01', '2026-01-31']);
  });

  it('dates residents by registration and requests by submission', async () => {
    setBarangayData();

    await run('barangays', { from: '2026-01-01' });

    expect(pool.execute.mock.calls[1][0]).toContain('DATE(created_at) >= ?');
    expect(pool.execute.mock.calls[2][0]).toContain('DATE(sr.created_at) >= ?');
  });

  it('forces staff to their own barangay in all three queries', async () => {
    setBarangayData();

    await run('barangays', { barangay: 'Other' }, staff());

    expect(pool.execute.mock.calls[0][1]).toEqual(['Balanti']);
    expect(pool.execute.mock.calls[1][1]).toEqual(['Balanti']);
    expect(pool.execute.mock.calls[2][1]).toEqual(['Balanti']);
  });
});

// ---------- staff report ----------

describe('staff report: rows', () => {
  it('maps a database row into a report row', async () => {
    setRows([staffRow()]);

    const { data } = await run('staff');

    expect(data.rows[0]).toEqual({
      id: 3,
      name: 'Sam Staff',
      email: 'sam@example.com',
      role: 'Barangay Staff',
      barangay: 'Balanti',
      officeName: 'Health Office',
      status: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([staffRow()]);

    const { data } = await run('staff');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('shows readable role names', async () => {
    setRows([
      staffRow({ id: 1, role: 'admin' }),
      staffRow({ id: 2, role: 'barangay_staff' }),
      staffRow({ id: 3, role: 'resident' }),
    ]);

    const { data } = await run('staff');

    expect(data.rows.map((row) => row.role)).toEqual([
      'Admin',
      'Barangay Staff',
      'Resident',
    ]);
  });

  it('shows an unknown role as it is stored', async () => {
    setRows([staffRow({ role: 'guest' })]);

    const { data } = await run('staff');

    expect(data.rows[0].role).toBe('guest');
  });

  it('uses empty text for a missing barangay or office', async () => {
    setRows([staffRow({ barangay: null, office_name: null })]);

    const { data } = await run('staff');

    expect(data.rows[0]).toMatchObject({ barangay: '', officeName: '' });
  });
});

describe('staff report: summary and filters', () => {
  it('counts staff, active accounts, and admins', async () => {
    setRows([
      staffRow({ id: 1, role: 'admin', status: 'Active' }),
      staffRow({ id: 2, role: 'barangay_staff', status: 'Active' }),
      staffRow({ id: 3, role: 'barangay_staff', status: 'Inactive' }),
    ]);

    const { data } = await run('staff');

    expect(data.summary).toEqual([
      { label: 'Staff', value: '3' },
      { label: 'Active', value: '2' },
      { label: 'Admins', value: '1' },
    ]);
  });

  it('filters by barangay, role, and status in order', async () => {
    await run('staff', { barangay: 'Balanti', role: 'admin', status: 'Active' });

    const [sql, params] = firstCall();
    expect(sql).toContain('sa.barangay = ?');
    expect(sql).toContain('sa.role = ?');
    expect(sql).toContain('sa.status = ?');
    expect(params).toEqual(['Balanti', 'admin', 'Active']);
  });

  it('adds no filters for an admin who asks for none', async () => {
    await run('staff');
    expect(firstCall()[1]).toEqual([]);
  });

  it('forces staff to their own barangay', async () => {
    await run('staff', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti']);
  });
});

// ---------- offices report ----------

describe('offices report', () => {
  it('maps a database row into a report row', async () => {
    setRows([officeRow()]);

    const { data } = await run('offices');

    expect(data.rows[0]).toEqual({
      id: 1,
      name: 'Health Office',
      barangay: 'Balanti',
      description: 'Handles health programs',
      status: 'Active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('has a value for every column', async () => {
    setRows([officeRow()]);

    const { data } = await run('offices');

    data.columns.forEach(({ key }) => {
      expect(Object.keys(data.rows[0])).toContain(key);
    });
  });

  it('uses an empty description when there is none', async () => {
    setRows([officeRow({ description: null })]);

    const { data } = await run('offices');

    expect(data.rows[0].description).toBe('');
  });

  it('counts offices and active offices', async () => {
    setRows([
      officeRow({ id: 1, status: 'Active' }),
      officeRow({ id: 2, status: 'Inactive' }),
      officeRow({ id: 3, status: 'Active' }),
    ]);

    const { data } = await run('offices');

    expect(data.summary).toEqual([
      { label: 'Offices', value: '3' },
      { label: 'Active', value: '2' },
    ]);
  });

  it('filters by barangay and status in order', async () => {
    await run('offices', { barangay: 'Balanti', status: 'Active' });

    const [sql, params] = firstCall();
    expect(sql).toContain('barangay = ?');
    expect(sql).toContain('status = ?');
    expect(params).toEqual(['Balanti', 'Active']);
  });

  it('forces staff to their own barangay', async () => {
    await run('offices', { barangay: 'Other' }, staff());
    expect(firstCall()[1]).toEqual(['Balanti']);
  });
});