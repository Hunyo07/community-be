// Database smoke test: confirms required tables exist and basic counts are readable.
import { pool, testConnection } from '../config/db.js';
import { ensureCoreSchema } from '../database/ensureSchema.js';

const requiredTables = [
  'resident_accounts',
  'staff_accounts',
  'services',
  'barangays',
  'offices',
  'service_categories',
  'document_types',
  'service_requests',
  'announcements',
  'notifications',
  'audit_logs',
  'system_settings'
];

// Connect, ensure schema, verify tables, then print a short status summary.
const smokeDatabase = async () => {
  const connection = await pool.getConnection();

  try {
    await testConnection();
    await ensureCoreSchema(connection);

    const [tables] = await connection.execute(
      `SELECT TABLE_NAME AS tableName
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${requiredTables.map(() => '?').join(',')})`,
      requiredTables
    );
    const foundTables = new Set(tables.map((table) => table.tableName));
    const missingTables = requiredTables.filter((table) => !foundTables.has(table));

    if (missingTables.length > 0) {
      throw new Error(`Missing required tables: ${missingTables.join(', ')}`);
    }

    const [[counts]] = await connection.execute(
      `SELECT
        (SELECT COUNT(*) FROM barangays) AS barangays,
        (SELECT COUNT(*) FROM offices) AS offices,
        (SELECT COUNT(*) FROM service_categories) AS serviceCategories,
        (SELECT COUNT(*) FROM document_types) AS documentTypes,
        (SELECT COUNT(*) FROM announcements) AS announcements,
        (SELECT COUNT(*) FROM system_settings) AS settings`
    );

    console.log('Database smoke check passed.');
    console.log(`Barangays: ${counts.barangays}`);
    console.log(`Offices: ${counts.offices}`);
    console.log(`Service categories: ${counts.serviceCategories}`);
    console.log(`Document types: ${counts.documentTypes}`);
    console.log(`Announcements: ${counts.announcements}`);
    console.log(`System settings: ${counts.settings}`);
  } finally {
    connection.release();
    await pool.end();
  }
};

smokeDatabase().catch((error) => {
  console.error('Database smoke check failed.');
  console.error(error.message);
  console.error('Check server/.env DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_NAME, then confirm MySQL Workbench can connect to the same database.');
  process.exitCode = 1;
});
