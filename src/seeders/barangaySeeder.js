// Seeds all Tarlac City barangays into the barangays table.
import { pool } from '../config/db.js';
import { ensureCoreSchema } from '../database/ensureSchema.js';
import { TARLAC_CITY_BARANGAYS } from './tarlacCityBarangays.js';

const seedBarangays = async () => {
  const connection = await pool.getConnection();

  try {
    await ensureCoreSchema(connection);
    await connection.beginTransaction();

    for (const name of TARLAC_CITY_BARANGAYS) {
      await connection.execute(
        `INSERT INTO barangays (name, captain, contact, status)
         VALUES (?, '', '', 'Active')
         ON DUPLICATE KEY UPDATE
          status = VALUES(status)`,
        [name]
      );
    }

    await connection.commit();

    const [[{ total }]] = await connection.query('SELECT COUNT(*) AS total FROM barangays');
    console.log(`Seeded ${TARLAC_CITY_BARANGAYS.length} Tarlac City barangays.`);
    console.log(`Barangays table now has ${total} row(s).`);
  } catch (error) {
    await connection.rollback();
    console.error('Failed to seed barangays.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
};

seedBarangays();
