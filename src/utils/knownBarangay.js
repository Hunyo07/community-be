// Confirms a barangay name exists in the master list before it is stored.
import { pool } from '../config/db.js';

export const assertKnownBarangay = async (barangay, { required = true } = {}) => {
  const name = String(barangay ?? '').trim();

  if (!name) {
    if (!required) return null;
    throw Object.assign(new Error('Barangay is required'), { statusCode: 400 });
  }

  if (name.length > 120) {
    throw Object.assign(new Error('Barangay must be 120 characters or fewer.'), { statusCode: 400 });
  }

  const [rows] = await pool.execute(
    'SELECT id, name FROM barangays WHERE LOWER(TRIM(name)) = LOWER(?) LIMIT 1',
    [name]
  );

  if (!rows.length) {
    throw Object.assign(new Error('Barangay is not recognized.'), { statusCode: 400 });
  }

  return rows[0].name;
};
