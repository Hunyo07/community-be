import mysql from 'mysql2/promise';
import { env } from './env.js';

// This file creates the MySQL connection pool used across the backend.
// Controllers borrow connections from the pool instead of opening a new one each time.

// Shared pool of database connections configured from env.db settings.
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Checks that the database is reachable by borrowing a connection and pinging it.
export const testConnection = async () => {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
};
