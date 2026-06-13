import { pool } from '../config/db.js';

export const getSettingValue = async (key, fallback = '') => {
  const [rows] = await pool.execute('SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1', [key]);
  return rows[0]?.setting_value ?? fallback;
};

export const isSettingEnabled = async (key, fallback = true) => {
  const value = await getSettingValue(key, fallback ? 'true' : 'false');
  return value === 'true';
};
