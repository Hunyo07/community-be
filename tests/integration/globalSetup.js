import mysql from 'mysql2/promise';
import { getTestDbConfig } from './testEnv.js';
import { ensureCoreSchema } from '../../src/database/ensureSchema.js';

// Runs once before all integration tests: creates the test database and tables.
export default async function setup() {
  const db = getTestDbConfig();

  const admin = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
  });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${db.database}\``);
  await admin.end();

  const connection = await mysql.createConnection({ ...db, multipleStatements: false });
  try {
    await ensureCoreSchema(connection);
  } finally {
    await connection.end();
  }
}
