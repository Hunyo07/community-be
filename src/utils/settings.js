import { pool } from "../config/db.js";

// This utility reads system settings from the database.
// It helps the app decide whether certain features are enabled or disabled.

// Looks up one setting_key and returns its value, or the provided fallback.
export const getSettingValue = async (key, fallback = "") => {
  const [rows] = await pool.execute(
    "SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1",
    [key],
  );
  return rows[0]?.setting_value ?? fallback;
};

// Treats a setting as a boolean flag by comparing its stored value to "true".
export const isSettingEnabled = async (key, fallback = true) => {
  const value = await getSettingValue(key, fallback ? "true" : "false");
  return value === "true";
};
