import dotenv from 'dotenv';

dotenv.config();

const toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

export const env = {
  port: toNumber(process.env.PORT, 5000),
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'change-this-development-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: toNumber(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'community_db'
  },
  mail: {
    user: process.env.GMAIL_USER || '',
    appPassword: process.env.GMAIL_APP_PASSWORD || '',
    otpExpiresMinutes: toNumber(process.env.OTP_EXPIRES_MINUTES, 10),
    allowSelfSigned: process.env.GMAIL_ALLOW_SELF_SIGNED === 'true'
  }
};
