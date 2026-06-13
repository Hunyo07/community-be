import { pool } from '../config/db.js';

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
