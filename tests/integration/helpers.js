import request from 'supertest';
import app from '../../src/app.js';
import { pool } from '../../src/config/db.js';
import { hashPassword } from '../../src/utils/password.js';

export { app, pool };

export const PASSWORD = 'TestPass123';

// Tables that tests change. Reference data (barangays, document types,
// settings, service categories) is kept.
const RESET_TABLES = [
  'registration_otps',
  'password_reset_otps',
  'resident_accounts',
  'staff_accounts',
  'services',
  'service_beneficiaries',
  'offices',
  'service_requests',
  'announcements',
  'notifications',
  'audit_logs',
  'revoked_tokens',
];

const staffPermissions = JSON.stringify([
  'dashboard:read', 'profile:read', 'profile:write', 'residents:read', 'residents:write',
  'services:read', 'services:directory:read', 'service-categories:read', 'requests:read',
  'requests:write', 'document-types:read', 'barangays:read', 'offices:read',
  'announcements:read', 'notifications:read',
]);

export const accounts = {
  admin: { email: 'admin@test.local', name: 'Test Admin' },
  staffBalanti: { email: 'staff.balanti@test.local', name: 'Staff Balanti', barangay: 'Balanti' },
  staffAguso: { email: 'staff.aguso@test.local', name: 'Staff Aguso', barangay: 'Aguso' },
  residentBalanti: { email: 'resident.balanti@test.local', first: 'Juan', last: 'Cruz', barangay: 'Balanti' },
  residentAguso: { email: 'resident.aguso@test.local', first: 'Maria', last: 'Santos', barangay: 'Aguso' },
  residentPending: { email: 'resident.pending@test.local', first: 'Pedro', last: 'Reyes', barangay: 'Balanti' },
};

// Empties the changing tables and inserts the same starting accounts every time.
export const resetDatabase = async () => {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of RESET_TABLES) {
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  // Reference data that tests may change goes back to its starting state.
  await pool.query("UPDATE document_types SET status = 'Active'");

  const hash = hashPassword(PASSWORD);

  await pool.execute(
    `INSERT INTO staff_accounts (name, email, barangay, password_hash, role, permissions, status)
     VALUES (?, ?, NULL, ?, 'admin', NULL, 'Active')`,
    [accounts.admin.name, accounts.admin.email, hash],
  );
  for (const key of ['staffBalanti', 'staffAguso']) {
    const a = accounts[key];
    await pool.execute(
      `INSERT INTO staff_accounts (name, email, barangay, password_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, 'barangay_staff', ?, 'Active')`,
      [a.name, a.email, a.barangay, hash, staffPermissions],
    );
  }

  const insertResident = (a, verification, account) =>
    pool.execute(
      `INSERT INTO resident_accounts
        (first_name, last_name, email, barangay, birth_date, age, gender, password_hash,
         selfie_id_image, verification_status, account_status, status)
       VALUES (?, ?, ?, ?, '1990-01-01', 36, 'Male', ?, 'uploads/test.jpg', ?, ?, ?)`,
      [a.first, a.last, a.email, a.barangay, hash, verification, account,
        verification === 'Verified' ? account : verification],
    );
  await insertResident(accounts.residentBalanti, 'Verified', 'Active');
  await insertResident(accounts.residentAguso, 'Verified', 'Active');
  await insertResident(accounts.residentPending, 'Pending', 'Inactive');
};

// Signs in through the real login route and returns the token.
export const loginAs = async (email, password = PASSWORD) => {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token;
};

// Shortcuts for sending requests with a token.
export const api = (token) => {
  const withAuth = (req) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
  return {
    get: (url) => withAuth(request(app).get(url)),
    post: (url, body) => withAuth(request(app).post(url)).send(body),
    patch: (url, body) => withAuth(request(app).patch(url)).send(body),
    delete: (url) => withAuth(request(app).delete(url)),
  };
};

export const dbRows = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

export const closePool = () => pool.end();
