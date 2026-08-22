// Auth controller: login, session user, password reset/change, and resident registration with OTP.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { assertMailerConfigured, sendOtpEmail, sendPasswordResetOtpEmail } from '../config/mailer.js';
import { emitRealtimeEvent } from '../realtime/socket.js';
import { normalizePermissions, PERMISSIONS, ROLES } from '../rbac/roles.js';
import { logAudit } from '../utils/auditLogger.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { isSettingEnabled } from '../utils/settings.js';
import {
  formatResidentName,
  normalizeMiddleName,
} from '../utils/residentName.js';

// Create a 6-digit one-time password for email verification.
const generateOtp = () => String(crypto.randomInt(100000, 999999));
// Store OTPs as hashes so the plain code is not kept in the database.
const hashOtp = (otp) => crypto.createHash('sha256').update(otp).digest('hex');
// Compute age in years from a YYYY-MM-DD birth date.
const calculateAge = (birthDate) => {
  const date = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDelta = today.getMonth() - date.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate())) age -= 1;
  return age;
};

// Throws a 400 error if any required body field is missing.
const requireFields = (body, fields) => {
  const missing = fields.filter((field) => !body[field]);

  if (missing.length > 0) {
    throw Object.assign(new Error(`Missing required fields: ${missing.join(', ')}`), { statusCode: 400 });
  }
};

// Normalize barangay names for comparison (trim, drop "Barangay" prefix, lowercase).
const normalizeBarangayName = (barangay = '') =>
  String(barangay)
    .trim()
    .replace(/^barangay\s+/i, '')
    .toLowerCase();

// Notify admins/staff who can review a newly submitted resident registration.
const notifyResidentRegistrationReviewers = async ({ residentId, firstName, middleName, lastName, barangay }) => {
  const [staffRows] = await pool.execute(
    `SELECT id, role, barangay, permissions, status
     FROM staff_accounts
     WHERE status = 'Active'
       AND role IN (?, ?)`,
    [ROLES.ADMIN, ROLES.BARANGAY_STAFF]
  );

  const residentBarangay = normalizeBarangayName(barangay);
  const reviewers = staffRows.filter((staff) => {
    const permissions = normalizePermissions(staff.permissions, staff.role);
    if (!permissions.includes(PERMISSIONS.RESIDENTS_READ) || !permissions.includes(PERMISSIONS.RESIDENTS_WRITE)) {
      return false;
    }

    if (staff.role === ROLES.ADMIN) return true;

    const canViewAllResidents = permissions.includes(PERMISSIONS.RESIDENTS_VIEW_ALL);
    return canViewAllResidents || normalizeBarangayName(staff.barangay) === residentBarangay;
  });

  if (!reviewers.length) return;

  const residentName = formatResidentName(firstName, middleName, lastName);
  await pool.query(
    `INSERT INTO notifications (user_id, user_role, title, message)
     VALUES ?`,
    [
      reviewers.map((reviewer) => [
        reviewer.id,
        reviewer.role,
        'Resident account needs verification',
        `${residentName} submitted a resident account for ${barangay}. Review the uploaded selfie with ID in Resident Registry.`
      ])
    ]
  );

  emitRealtimeEvent('notifications:changed', {
    action: 'created',
    userRoles: [ROLES.ADMIN, ROLES.BARANGAY_STAFF],
    residentId
  });
};

// Build a signed JWT containing the user's identity and permissions.
const createToken = (user) =>
  jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      barangay: user.barangay || null,
      officeId: user.officeId || null,
      permissions: normalizePermissions(user.permissions, user.role),
      accountType: user.accountType
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );

// Look up a resident account by email for login/password flows.
const getResidentUser = async (email) => {
  const [rows] = await pool.execute(
    `SELECT id, first_name, middle_name, last_name, email, barangay, password_hash, role, verification_status, account_status, status
     FROM resident_accounts
     WHERE email = ?`,
    [email]
  );

  if (rows.length === 0) return null;

  const resident = rows[0];
  return {
    id: resident.id,
    name: formatResidentName(resident.first_name, resident.middle_name, resident.last_name),
    email: resident.email,
    barangay: resident.barangay,
    passwordHash: resident.password_hash,
    role: resident.role,
    verificationStatus: resident.verification_status || resident.status,
    accountStatus: resident.account_status || (resident.status === 'Inactive' ? 'Inactive' : 'Active'),
    status: resident.status,
    accountType: 'resident'
  };
};

// Look up a staff account by email for login/password flows.
const getStaffUser = async (email) => {
  const [rows] = await pool.execute(
    `SELECT id, name, email, barangay, office_id, password_hash, role, permissions, status
     FROM staff_accounts
     WHERE email = ?`,
    [email]
  );

  if (rows.length === 0) return null;

  const staff = rows[0];
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    barangay: staff.barangay,
    officeId: staff.office_id,
    passwordHash: staff.password_hash,
    role: staff.role,
    permissions: normalizePermissions(staff.permissions, staff.role),
    status: staff.status,
    accountType: 'staff'
  };
};

// Prefer staff match, otherwise try resident, for a given email.
const getUserByEmail = async (email) => (await getStaffUser(email)) || (await getResidentUser(email));

// Hash and save a new password on the correct account table.
const updateUserPassword = async ({ accountType, id, password }) => {
  const passwordHash = hashPassword(password);
  const table = accountType === 'staff' ? 'staff_accounts' : 'resident_accounts';
  const [result] = await pool.execute(`UPDATE ${table} SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
  return result.affectedRows > 0;
};

// Find an active/verified user who is allowed to reset their password.
const findResettableUser = async (email) => {
  const staff = await getStaffUser(email);
  if (staff && staff.status === 'Active') return staff;

  const resident = await getResidentUser(email);
  if (resident && resident.verificationStatus === 'Verified' && resident.accountStatus === 'Active') return resident;

  return null;
};

// Validate credentials, block inactive accounts, and return a JWT + user payload.
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    requireFields(req.body, ['email', 'password']);

    const user = (await getStaffUser(email)) || (await getResidentUser(email));

    if (!user || !verifyPassword(password, user.passwordHash)) {
      await logAudit({
        user: null,
        action: 'auth.login_failed',
        entityType: 'auth',
        details: { email, reason: 'invalid_credentials' }
      });
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isResidentBlocked =
      user.accountType === 'resident' &&
      (user.verificationStatus !== 'Verified' || user.accountStatus !== 'Active');
    const isStaffBlocked = user.accountType === 'staff' && user.status !== 'Active';

    if (isResidentBlocked || isStaffBlocked) {
      await logAudit({
        user,
        action: 'auth.login_blocked',
        entityType: user.accountType === 'resident' ? 'resident_accounts' : 'staff_accounts',
        entityId: user.id,
        details: {
          email: user.email,
          status: user.status,
          verificationStatus: user.verificationStatus,
          accountStatus: user.accountStatus
        }
      });
      return res.status(403).json({ message: 'Your account is not verified and active yet' });
    }

    const token = createToken(user);
    await logAudit({
      user,
      action: 'auth.login_success',
      entityType: user.accountType === 'resident' ? 'resident_accounts' : 'staff_accounts',
      entityId: user.id,
      details: { email: user.email, accountType: user.accountType }
    });

    return res.json({
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          barangay: user.barangay,
          officeId: user.officeId,
          accountType: user.accountType,
          verificationStatus: user.verificationStatus,
          accountStatus: user.accountStatus,
          permissions: normalizePermissions(user.permissions, user.role)
        }
      }
    });
  } catch (error) {
    return next(error);
  }
};

// Return the authenticated user from the JWT (used by /auth/me).
export const getCurrentUser = (req, res) => {
  res.json({
    data: {
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        barangay: req.user.barangay,
        officeId: req.user.officeId,
        accountType: req.user.accountType,
        permissions: req.user.permissions
      }
    }
  });
};

// Email a password-reset OTP if the account exists (always returns a generic message).
export const requestPasswordResetOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    requireFields(req.body, ['email']);
    assertMailerConfigured();

    const user = await findResettableUser(email);
    if (user) {
      const otp = generateOtp();
      const expiresAt = new Date(Date.now() + env.mail.otpExpiresMinutes * 60 * 1000);

      await pool.execute(
        `INSERT INTO password_reset_otps (email, otp_hash, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE otp_hash = VALUES(otp_hash), expires_at = VALUES(expires_at), used_at = NULL`,
        [email, hashOtp(otp), expiresAt]
      );

      await sendPasswordResetOtpEmail({ to: email, otp });
      await logAudit({
        user,
        action: 'auth.password_reset_requested',
        entityType: user.accountType === 'resident' ? 'resident_accounts' : 'staff_accounts',
        entityId: user.id,
        details: { email, expiresAt }
      });
    } else {
      await logAudit({
        user: null,
        action: 'auth.password_reset_requested_unknown',
        entityType: 'auth',
        details: { email }
      });
    }

    return res.json({ message: 'If the email belongs to an active account, a password reset OTP was sent.' });
  } catch (error) {
    return next(error);
  }
};

// Verify the reset OTP and set a new password.
export const resetPasswordWithOtp = async (req, res, next) => {
  try {
    const { email, otp, password } = req.body;
    requireFields(req.body, ['email', 'otp', 'password']);

    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    const user = await findResettableUser(email);
    const [otps] = await pool.execute(
      'SELECT id, otp_hash, expires_at, used_at FROM password_reset_otps WHERE email = ?',
      [email]
    );

    if (
      !user ||
      otps.length === 0 ||
      otps[0].used_at ||
      otps[0].otp_hash !== hashOtp(otp) ||
      new Date(otps[0].expires_at).getTime() < Date.now()
    ) {
      return res.status(400).json({ message: 'Invalid or expired password reset OTP' });
    }

    await updateUserPassword({ accountType: user.accountType, id: user.id, password });
    await pool.execute('UPDATE password_reset_otps SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [otps[0].id]);
    await logAudit({
      user,
      action: 'auth.password_reset_completed',
      entityType: user.accountType === 'resident' ? 'resident_accounts' : 'staff_accounts',
      entityId: user.id,
      details: { email }
    });

    return res.json({ message: 'Password reset successfully' });
  } catch (error) {
    return next(error);
  }
};

// Change password for the currently logged-in user (requires current password).
export const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    requireFields(req.body, ['currentPassword', 'newPassword']);

    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters long' });
    }

    const user = await getUserByEmail(req.user.email);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    await updateUserPassword({ accountType: user.accountType, id: user.id, password: newPassword });
    await logAudit({
      user: req.user,
      action: 'auth.password_changed',
      entityType: user.accountType === 'resident' ? 'resident_accounts' : 'staff_accounts',
      entityId: user.id
    });

    return res.json({ message: 'Password changed successfully' });
  } catch (error) {
    return next(error);
  }
};

// Send a registration OTP to a new resident email (if registration is enabled).
export const requestRegistrationOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    requireFields(req.body, ['email']);
    assertMailerConfigured();

    if (!(await isSettingEnabled('registration_enabled', true))) {
      return res.status(403).json({ message: 'Resident registration is currently disabled' });
    }

    const [existingResidents] = await pool.execute('SELECT id FROM resident_accounts WHERE email = ?', [email]);
    if (existingResidents.length > 0) {
      return res.status(409).json({ message: 'An account already exists for this email' });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + env.mail.otpExpiresMinutes * 60 * 1000);

    await pool.execute(
      `INSERT INTO registration_otps (email, otp_hash, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE otp_hash = VALUES(otp_hash), expires_at = VALUES(expires_at), verified_at = NULL`,
      [email, hashOtp(otp), expiresAt]
    );

    await sendOtpEmail({ to: email, otp });
    await logAudit({
      user: null,
      action: 'registration.otp_requested',
      entityType: 'registration_otps',
      details: { email, expiresAt }
    });

    return res.json({ message: 'OTP sent to email' });
  } catch (error) {
    return next(error);
  }
};

// Mark the registration OTP as verified so the account can be submitted next.
export const verifyRegistrationOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    requireFields(req.body, ['email', 'otp']);

    const [otps] = await pool.execute(
      'SELECT id, otp_hash, expires_at FROM registration_otps WHERE email = ?',
      [email]
    );

    if (otps.length === 0 || otps[0].otp_hash !== hashOtp(otp)) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (new Date(otps[0].expires_at).getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    await pool.execute('UPDATE registration_otps SET verified_at = CURRENT_TIMESTAMP WHERE id = ?', [otps[0].id]);
    await logAudit({
      user: null,
      action: 'registration.otp_verified',
      entityType: 'registration_otps',
      entityId: otps[0].id,
      details: { email }
    });

    return res.json({ message: 'OTP verified' });
  } catch (error) {
    return next(error);
  }
};

// Create a pending resident account after OTP verify + selfie-with-ID upload.
export const registerResident = async (req, res, next) => {
  try {
    requireFields(req.body, ['firstName', 'lastName', 'email', 'barangay', 'birthDate', 'password', 'otp']);

    if (!(await isSettingEnabled('registration_enabled', true))) {
      return res.status(403).json({ message: 'Resident registration is currently disabled' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Selfie with ID image is required' });
    }

    const { firstName, lastName, email, barangay, birthDate, password, otp } = req.body;
    const middleName = normalizeMiddleName(req.body.middleName);
    const age = calculateAge(birthDate);

    if (age === null || age < 13 || age > 120) {
      return res.status(400).json({ message: 'Birthdate must be valid and account holder must be at least 13 years old' });
    }

    const [otps] = await pool.execute(
      'SELECT otp_hash, expires_at, verified_at FROM registration_otps WHERE email = ?',
      [email]
    );

    if (
      otps.length === 0 ||
      otps[0].otp_hash !== hashOtp(otp) ||
      new Date(otps[0].expires_at).getTime() < Date.now() ||
      !otps[0].verified_at
    ) {
      return res.status(400).json({ message: 'Verify your email OTP before creating an account' });
    }

    const passwordHash = hashPassword(password);

    const [result] = await pool.execute(
      `INSERT INTO resident_accounts
        (first_name, middle_name, last_name, email, barangay, birth_date, age, password_hash, selfie_id_image, verification_status, account_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Inactive', 'Pending')`,
      [firstName, middleName, lastName, email, barangay, birthDate, age, passwordHash, req.file.path]
    );

    await pool.execute('DELETE FROM registration_otps WHERE email = ?', [email]);
    await logAudit({
      user: { id: result.insertId, role: ROLES.RESIDENT },
      action: 'registration.resident_submitted',
      entityType: 'resident_accounts',
      entityId: result.insertId,
      details: { email, barangay, birthDate, age, verificationStatus: 'Pending', accountStatus: 'Inactive', hasSelfieId: true }
    });

    emitRealtimeEvent('residents:changed', {
      action: 'registered',
      data: {
        id: result.insertId,
        firstName,
        middleName,
        lastName,
        email,
        barangay,
        birthDate,
        age,
        role: ROLES.RESIDENT,
        verificationStatus: 'Pending',
        accountStatus: 'Inactive',
        status: 'Pending'
      }
    });
    await notifyResidentRegistrationReviewers({
      residentId: result.insertId,
      firstName,
      middleName,
      lastName,
      barangay
    });
    emitRealtimeEvent('dashboard:changed', { reason: 'resident-registered' });

    return res.status(201).json({
      message: 'Resident account submitted for verification',
      data: {
        id: result.insertId,
        firstName,
        middleName,
        lastName,
        email,
        barangay,
        birthDate,
        age,
        role: ROLES.RESIDENT,
        verificationStatus: 'Pending',
        accountStatus: 'Inactive',
        status: 'Pending'
      }
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An account already exists for this email' });
    }

    return next(error);
  }
};
