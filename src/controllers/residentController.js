import fs from "node:fs";
import path from "node:path";
import { pool } from "../config/db.js";

import { sendAccountStatusEmail } from "../config/mailer.js";
import { emitRealtimeEvent } from "../realtime/socket.js";
import { PERMISSIONS } from "../rbac/roles.js";
import { logAudit } from "../utils/auditLogger.js";
import { hashPassword } from "../utils/password.js";

// This controller manages resident account operations on the backend.
// It validates input, stores resident data, and sends real-time updates after changes.

const formatDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const calculateAge = (birthDate) => {
  if (!birthDate) return null;
  const date = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDelta = today.getMonth() - date.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < date.getDate()))
    age -= 1;
  return age;
};

// Converts a database resident row into the camelCase shape the frontend expects.
const mapResident = (resident) => ({
  id: `RES-${String(resident.id).padStart(4, "0")}`,
  rawId: resident.id,
  name: `${resident.first_name} ${resident.last_name}`,
  firstName: resident.first_name,
  lastName: resident.last_name,
  email: resident.email,
  contact: resident.contact_number || resident.email,
  contactNumber: resident.contact_number || "",
  barangay: resident.barangay,
  purokSitio: resident.purok_sitio || "",
  birthDate: formatDateOnly(resident.birth_date),
  age: resident.age || null,
  gender: resident.gender || "Unspecified",
  hasSelfieId: Boolean(resident.selfie_id_image),
  verificationStatus: resident.verification_status || resident.status,
  accountStatus:
    resident.account_status ||
    (resident.status === "Inactive" ? "Inactive" : "Active"),
  status: resident.verification_status || resident.status,
  role: resident.role,
  createdAt: resident.created_at,
});

const allowedVerificationStatuses = [
  "Pending",
  "Needs Correction",
  "Verified",
  "Rejected",
];
const allowedAccountStatuses = ["Active", "Inactive"];
const allowedGenders = ["Female", "Male", "Unspecified"];

// Staff without view-all permission are limited to their assigned barangay.
const canViewAllResidents = (user) =>
  user?.role !== "barangay_staff" ||
  user.permissions?.includes(PERMISSIONS.RESIDENTS_VIEW_ALL);

// Builds a SQL WHERE clause that scopes resident queries to the user's barangay.
const getResidentScope = (user, tableAlias = "") => {
  if (canViewAllResidents(user)) {
    return { clause: "", values: [] };
  }

  const prefix = tableAlias ? `${tableAlias}.` : "";
  return {
    clause: `${prefix}barangay = ?`,
    values: [user?.barangay || ""],
  };
};

// Loads one resident by id and maps it for API responses.
const getResidentById = async (id) => {
  const [rows] = await pool.execute(
    `SELECT id, first_name, last_name, email, contact_number, barangay, purok_sitio, birth_date, age, gender, selfie_id_image, role, verification_status, account_status, status, created_at
     FROM resident_accounts
     WHERE id = ?`,
    [id],
  );

  return rows[0] ? mapResident(rows[0]) : null;
};

const ensureResidentAccess = (resident, user) => {
  if (!resident) return false;
  return canViewAllResidents(user) || resident.barangay === user?.barangay;
};

const applyResidentWriteScope = (payload, user) => {
  if (canViewAllResidents(user)) return payload;
  return { ...payload, barangay: user?.barangay || payload.barangay };
};

// Validates and normalizes create/update fields for a resident account.
const normalizeResidentPayload = (body, existing = {}) => {
  const payload = {
    firstName: body.firstName ?? existing.firstName,
    lastName: body.lastName ?? existing.lastName,
    email: body.email ?? existing.email,
    barangay: body.barangay ?? existing.barangay,
    birthDate:
      body.birthDate === ""
        ? null
        : (body.birthDate ?? existing.birthDate ?? null),
    gender: body.gender ?? existing.gender ?? "Unspecified",
    purokSitio: body.purokSitio ?? existing.purokSitio ?? "",
    contactNumber: body.contactNumber ?? existing.contactNumber ?? "",
    verificationStatus:
      body.verificationStatus ??
      body.status ??
      existing.verificationStatus ??
      existing.status ??
      "Pending",
    accountStatus: body.accountStatus ?? existing.accountStatus ?? "Inactive",
    password: body.password || "",
  };
  payload.age = payload.birthDate
    ? calculateAge(payload.birthDate)
    : body.age === "" || body.age === undefined
      ? (existing.age ?? null)
      : Number(body.age);

  if (
    !payload.firstName ||
    !payload.lastName ||
    !payload.email ||
    !payload.barangay ||
    !payload.birthDate
  ) {
    throw Object.assign(
      new Error(
        "First name, last name, email, barangay, and birthdate are required",
      ),
      { statusCode: 400 },
    );
  }

  if (payload.age === null || payload.age < 0 || payload.age > 120) {
    throw Object.assign(
      new Error("Birthdate must produce a valid resident age"),
      { statusCode: 400 },
    );
  }

  if (
    payload.age !== null &&
    (!Number.isInteger(payload.age) || payload.age < 0)
  ) {
    throw Object.assign(new Error("Age must be a valid number"), {
      statusCode: 400,
    });
  }

  if (!allowedGenders.includes(payload.gender)) {
    throw Object.assign(new Error("Invalid resident gender"), {
      statusCode: 400,
    });
  }

  if (!allowedVerificationStatuses.includes(payload.verificationStatus)) {
    throw Object.assign(new Error("Invalid resident verification status"), {
      statusCode: 400,
    });
  }

  if (!allowedAccountStatuses.includes(payload.accountStatus)) {
    throw Object.assign(new Error("Invalid resident account status"), {
      statusCode: 400,
    });
  }

  if (payload.verificationStatus !== "Verified") {
    payload.accountStatus = "Inactive";
  }

  return payload;
};

// Lists residents visible to the current user, newest first.
export const getResidents = async (req, res, next) => {
  try {
    const scope = getResidentScope(req.user);
    const where = scope.clause ? `WHERE ${scope.clause}` : "";
    const [residents] = await pool.execute(
      `SELECT id, first_name, last_name, email, contact_number, barangay, purok_sitio, birth_date, age, gender, selfie_id_image, role, verification_status, account_status, status, created_at
       FROM resident_accounts
       ${where}
       ORDER BY created_at DESC`,
      scope.values,
    );

    return res.json({ data: residents.map(mapResident) });
  } catch (error) {
    return next(error);
  }
};

// Creates a resident account, optionally storing an uploaded selfie-with-ID file.
export const createResident = async (req, res, next) => {
  try {
    const payload = normalizeResidentPayload(
      applyResidentWriteScope(req.body, req.user),
    );
    const passwordHash = hashPassword(payload.password || "Resident@123");

    const [result] = await pool.execute(
      `INSERT INTO resident_accounts
        (first_name, last_name, email, contact_number, barangay, purok_sitio, birth_date, age, gender, password_hash, selfie_id_image, verification_status, account_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.firstName,
        payload.lastName,
        payload.email,
        payload.contactNumber,
        payload.barangay,
        payload.purokSitio,
        payload.birthDate,
        payload.age,
        payload.gender,
        passwordHash,
        req.file?.path || null,
        payload.verificationStatus,
        payload.accountStatus,
        payload.verificationStatus === "Verified"
          ? payload.accountStatus
          : payload.verificationStatus,
      ],
    );

    const resident = await getResidentById(result.insertId);

    await logAudit({
      user: req.user,
      action: "residents.create",
      entityType: "resident_accounts",
      entityId: result.insertId,
      details: {
        ...payload,
        password: payload.password ? "provided" : "default",
        hasSelfieId: Boolean(req.file),
      },
    });
    emitRealtimeEvent("residents:changed", {
      action: "created",
      data: resident,
    });
    emitRealtimeEvent("dashboard:changed", { reason: "resident-created" });

    return res.status(201).json({ data: resident });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return res
        .status(409)
        .json({ message: "A resident account already exists for this email" });
    return next(error);
  }
};

// Updates an existing resident's profile fields, password, or selfie image.
export const updateResident = async (req, res, next) => {
  try {
    const existing = await getResidentById(req.params.id);
    if (!existing)
      return res.status(404).json({ message: "Resident not found" });
    if (!ensureResidentAccess(existing, req.user)) {
      return res
        .status(403)
        .json({
          message: "You can only manage residents in your assigned barangay",
        });
    }

    const payload = applyResidentWriteScope(
      normalizeResidentPayload(req.body, existing),
      req.user,
    );
    const values = [
      payload.firstName,
      payload.lastName,
      payload.email,
      payload.contactNumber,
      payload.barangay,
      payload.purokSitio,
      payload.birthDate,
      payload.age,
      payload.gender,
      payload.verificationStatus,
      payload.accountStatus,
      payload.verificationStatus === "Verified"
        ? payload.accountStatus
        : payload.verificationStatus,
    ];
    let passwordSql = "";
    let selfieSql = "";

    if (payload.password) {
      passwordSql = ", password_hash = ?";
      values.push(hashPassword(payload.password));
    }

    if (req.file) {
      selfieSql = ", selfie_id_image = ?";
      values.push(req.file.path);
    }

    values.push(req.params.id);

    await pool.execute(
      `UPDATE resident_accounts
       SET first_name = ?, last_name = ?, email = ?, contact_number = ?, barangay = ?, purok_sitio = ?, birth_date = ?, age = ?, gender = ?, verification_status = ?, account_status = ?, status = ?${passwordSql}${selfieSql}
       WHERE id = ?`,
      values,
    );

    const resident = await getResidentById(req.params.id);

    await logAudit({
      user: req.user,
      action: "residents.update",
      entityType: "resident_accounts",
      entityId: req.params.id,
      details: {
        ...payload,
        password: payload.password ? "changed" : "unchanged",
        selfieIdChanged: Boolean(req.file),
      },
    });
    emitRealtimeEvent("residents:changed", {
      action: "updated",
      data: resident,
    });
    emitRealtimeEvent("dashboard:changed", { reason: "resident-updated" });

    return res.json({ data: resident });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return res
        .status(409)
        .json({ message: "A resident account already exists for this email" });
    return next(error);
  }
};

// Returns the signed-in resident's own profile (self-service read).
export const getMyResidentProfile = async (req, res, next) => {
  try {
    if (req.user?.accountType !== "resident") {
      return res
        .status(403)
        .json({ message: "Only residents can access this profile" });
    }

    const resident = await getResidentById(req.user.id);
    if (!resident)
      return res.status(404).json({ message: "Resident profile not found" });
    return res.json({ data: resident });
  } catch (error) {
    return next(error);
  }
};

// Lets a resident update limited profile fields without changing verification status.
export const updateMyResidentProfile = async (req, res, next) => {
  try {
    if (req.user?.accountType !== "resident") {
      return res
        .status(403)
        .json({ message: "Only residents can update this profile" });
    }

    const existing = await getResidentById(req.user.id);
    if (!existing)
      return res.status(404).json({ message: "Resident profile not found" });

    const payload = normalizeResidentPayload(
      {
        ...req.body,
        email: existing.email,
        barangay: existing.barangay,
        verificationStatus: existing.verificationStatus,
        accountStatus: existing.accountStatus,
      },
      existing,
    );

    await pool.execute(
      `UPDATE resident_accounts
       SET first_name = ?, last_name = ?, contact_number = ?, purok_sitio = ?, birth_date = ?, age = ?, gender = ?
       WHERE id = ?`,
      [
        payload.firstName,
        payload.lastName,
        payload.contactNumber,
        payload.purokSitio,
        payload.birthDate,
        payload.age,
        payload.gender,
        req.user.id,
      ],
    );

    const resident = await getResidentById(req.user.id);

    await logAudit({
      user: req.user,
      action: "profile.update",
      entityType: "resident_accounts",
      entityId: req.user.id,
      details: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        contactNumber: payload.contactNumber,
        purokSitio: payload.purokSitio,
        birthDate: payload.birthDate,
        gender: payload.gender,
      },
    });
    emitRealtimeEvent("residents:changed", {
      action: "profile-updated",
      data: resident,
    });

    return res.json({ data: resident });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return res
        .status(409)
        .json({ message: "A resident account already exists for this email" });
    return next(error);
  }
};

// Updates verification or account status and notifies the resident by email when needed.
export const updateResidentStatus = async (req, res, next) => {
  try {
    const { status, verificationStatus, accountStatus, reason = "" } = req.body;
    const requestedVerificationStatus =
      verificationStatus ||
      (allowedVerificationStatuses.includes(status) ? status : null);
    const requestedAccountStatus =
      accountStatus ||
      (allowedAccountStatuses.includes(status) ? status : null);

    if (!requestedVerificationStatus && !requestedAccountStatus) {
      return res
        .status(400)
        .json({ message: "Invalid resident status update" });
    }

    const existing = await getResidentById(req.params.id);
    if (!existing)
      return res.status(404).json({ message: "Resident not found" });
    if (!ensureResidentAccess(existing, req.user)) {
      return res
        .status(403)
        .json({
          message: "You can only verify residents in your assigned barangay",
        });
    }

    const nextVerificationStatus =
      requestedVerificationStatus || existing.verificationStatus;
    let nextAccountStatus = requestedAccountStatus || existing.accountStatus;

    if (!allowedVerificationStatuses.includes(nextVerificationStatus)) {
      return res
        .status(400)
        .json({ message: "Invalid resident verification status" });
    }

    if (!allowedAccountStatuses.includes(nextAccountStatus)) {
      return res
        .status(400)
        .json({ message: "Invalid resident account status" });
    }

    if (nextVerificationStatus !== "Verified") {
      nextAccountStatus = "Inactive";
    }

    if (requestedAccountStatus && nextVerificationStatus !== "Verified") {
      return res
        .status(400)
        .json({
          message: "Only verified residents can be activated or deactivated",
        });
    }

    const legacyStatus =
      nextVerificationStatus === "Verified"
        ? nextAccountStatus
        : nextVerificationStatus;
    const [result] = await pool.execute(
      "UPDATE resident_accounts SET verification_status = ?, account_status = ?, status = ? WHERE id = ?",
      [nextVerificationStatus, nextAccountStatus, legacyStatus, req.params.id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Resident not found" });
    }

    const resident = await getResidentById(req.params.id);
    const shouldEmailResident = Boolean(
      requestedVerificationStatus || requestedAccountStatus,
    );

    if (shouldEmailResident) {
      sendAccountStatusEmail({
        to: resident.email,
        name: resident.name,
        status: requestedVerificationStatus || requestedAccountStatus,
        reason,
      }).catch((error) => {
        console.error(
          `Failed to send resident status email to ${resident.email}: ${error.message}`,
        );
      });
    }

    if (shouldEmailResident) {
      const notificationMessage =
        requestedVerificationStatus === "Verified"
          ? "Your resident account has been approved. You can now sign in to CommUnity."
          : requestedVerificationStatus === "Needs Correction"
            ? `Your resident account needs correction before approval.${reason ? ` Reason: ${reason}` : ""}`
            : requestedVerificationStatus === "Rejected"
              ? `Your resident account registration was rejected.${reason ? ` Reason: ${reason}` : ""}`
              : requestedAccountStatus
                ? `Your resident account is now ${requestedAccountStatus}.`
                : `Your resident verification status is now ${nextVerificationStatus}.`;

      await pool.execute(
        `INSERT INTO notifications (user_id, user_role, title, message)
         VALUES (?, 'resident', ?, ?)`,
        [resident.rawId, "Resident verification updated", notificationMessage],
      );
      emitRealtimeEvent("notifications:changed", {
        action: "created",
        userId: resident.rawId,
        userRole: "resident",
      });
    }

    await logAudit({
      user: req.user,
      action: "residents.status_update",
      entityType: "resident_accounts",
      entityId: req.params.id,
      details: {
        verificationStatus: nextVerificationStatus,
        accountStatus: nextAccountStatus,
        reason,
      },
    });
    emitRealtimeEvent("residents:changed", {
      action: "status-updated",
      data: resident,
    });
    emitRealtimeEvent("dashboard:changed", {
      reason: "resident-status-updated",
    });

    return res.json({ data: resident });
  } catch (error) {
    return next(error);
  }
};

// Streams the resident's uploaded selfie-with-ID file to authorized staff.
export const getResidentSelfieId = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      "SELECT barangay, selfie_id_image FROM resident_accounts WHERE id = ?",
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Resident not found" });
    }

    if (
      !canViewAllResidents(req.user) &&
      rows[0].barangay !== req.user?.barangay
    ) {
      return res
        .status(403)
        .json({
          message:
            "You can only view resident documents in your assigned barangay",
        });
    }

    const imagePath = rows[0].selfie_id_image;
    if (!imagePath) {
      return res
        .status(404)
        .json({ message: "Resident has no uploaded selfie with ID" });
    }

    const resolvedPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.resolve(imagePath);
    if (!fs.existsSync(resolvedPath)) {
      return res
        .status(404)
        .json({
          message: "Uploaded selfie with ID file was not found on disk",
        });
    }

    return res.sendFile(resolvedPath);
  } catch (error) {
    return next(error);
  }
};
