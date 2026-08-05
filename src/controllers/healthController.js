import { pool } from '../config/db.js';

// This controller checks whether the API and database are healthy.
// Clients call it to confirm the server can reach MySQL before doing real work.

// Runs a simple SELECT 1 query and returns ok status when the database responds.
export const getHealth = async (req, res, next) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
};
