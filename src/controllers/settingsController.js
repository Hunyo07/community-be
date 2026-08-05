import { pool } from "../config/db.js";
import { emitRealtimeEvent } from "../realtime/socket.js";
import { logAudit } from "../utils/auditLogger.js";

// This controller manages configurable system settings.
// It reads values from the database and allows admins to update approved settings.

const editableSettings = new Set([
  "registration_enabled",
  "default_service_visibility",
  "request_auto_notifications",
  "system_contact_email",
]);

const settingValidators = {
  registration_enabled: (value) => ["true", "false"].includes(value),
  default_service_visibility: (value) =>
    ["own_barangay", "all_barangays", "public"].includes(value),
  request_auto_notifications: (value) => ["true", "false"].includes(value),
  system_contact_email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
};

// Shapes a database settings row into the camelCase object the API returns.
const mapSetting = (setting) => ({
  id: setting.id,
  key: setting.setting_key,
  value: setting.setting_value,
  description: setting.description,
  updatedAt: setting.updated_at,
});

// Lists every system setting for authenticated admin screens.
export const listSettings = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, setting_key, setting_value, description, updated_at
       FROM system_settings
       ORDER BY setting_key ASC`,
    );

    return res.json({ data: rows.map(mapSetting) });
  } catch (error) {
    return next(error);
  }
};

// Returns only the safe public settings used on landing and registration pages.
export const getPublicSettings = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT setting_key, setting_value
       FROM system_settings
       WHERE setting_key IN ('registration_enabled', 'system_contact_email')`,
    );
    const settings = Object.fromEntries(
      rows.map((row) => [row.setting_key, row.setting_value]),
    );

    return res.json({
      data: {
        registrationEnabled: settings.registration_enabled !== "false",
        systemContactEmail:
          settings.system_contact_email || "admin@community.test",
      },
    });
  } catch (error) {
    return next(error);
  }
};

// Lists active barangays for public dropdowns (for example, registration).
export const listPublicBarangays = async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, district, status
       FROM barangays
       WHERE status = 'Active'
       ORDER BY name ASC`,
    );

    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
};

// Returns high-level community counts shown on the public marketing page.
export const getPublicStats = async (req, res, next) => {
  try {
    const [[residentCounts]] = await pool.query(
      `SELECT
        COUNT(*) AS totalResidents
       FROM resident_accounts`,
    );
    const [[barangayCounts]] = await pool.query(
      `SELECT
        COUNT(*) AS activeBarangays
       FROM barangays
       WHERE status = 'Active'`,
    );
    const [[serviceCounts]] = await pool.query(
      `SELECT
        SUM(status = 'Active') AS activeServices
       FROM services`,
    );
    const [[beneficiaryCounts]] = await pool.query(
      `SELECT
        COUNT(*) AS beneficiariesServed
       FROM service_beneficiaries
       WHERE status = 'Served'`,
    );

    return res.json({
      data: {
        registeredResidents: Number(residentCounts.totalResidents || 0),
        barangaysCovered: Number(barangayCounts.activeBarangays || 0),
        activeServices: Number(serviceCounts.activeServices || 0),
        beneficiariesServed: Number(beneficiaryCounts.beneficiariesServed || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
};

// Validates and updates one editable setting key, then notifies clients in real time.
export const updateSetting = async (req, res, next) => {
  try {
    const { value } = req.body;
    const key = req.params.key;

    if (!editableSettings.has(key)) {
      return res
        .status(404)
        .json({ message: "Setting not found or not editable" });
    }

    if (value === undefined || value === null || value === "") {
      return res.status(400).json({ message: "Setting value is required" });
    }

    const normalizedValue = String(value).trim();
    const validator = settingValidators[key];
    if (validator && !validator(normalizedValue)) {
      return res.status(400).json({ message: "Invalid setting value" });
    }

    const [result] = await pool.execute(
      `UPDATE system_settings
       SET setting_value = ?
       WHERE setting_key = ?`,
      [normalizedValue, key],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Setting not found" });
    }

    const [rows] = await pool.execute(
      `SELECT id, setting_key, setting_value, description, updated_at
       FROM system_settings
       WHERE setting_key = ?`,
      [key],
    );
    const setting = mapSetting(rows[0]);

    await logAudit({
      user: req.user,
      action: "settings.update",
      entityType: "system_settings",
      entityId: key,
      details: { value: normalizedValue },
    });
    emitRealtimeEvent("settings:changed", { action: "updated", key });

    return res.json({ data: setting });
  } catch (error) {
    return next(error);
  }
};
