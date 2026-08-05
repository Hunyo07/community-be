import dotenv from "dotenv";

dotenv.config();

// This file loads environment variables and exposes them as a single config object.
// Helpers below turn strings from .env into numbers and origin lists the app can use.

const toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseClientOrigins = (value) => {
  if (!value) {
    return [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://0.0.0.0:5173",
    ];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};

// Shared app settings (host, JWT, database, mail) read from process.env with safe defaults.
export const env = {
  host: process.env.HOST || "0.0.0.0",
  port: toNumber(process.env.PORT, 5000),
  nodeEnv: process.env.NODE_ENV || "development",
  clientOrigin:
    process.env.CLIENT_ORIGIN ||
    "http://localhost:5173,http://127.0.0.1:5173,http://0.0.0.0:5173",
  clientOrigins: parseClientOrigins(
    process.env.CLIENT_ORIGIN ||
      "http://localhost:5173,http://127.0.0.1:5173,http://0.0.0.0:5173",
  ),
  jwtSecret: process.env.JWT_SECRET || "change-this-development-secret",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  db: {
    host: process.env.DB_HOST || "localhost",
    port: toNumber(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "community_db",
  },
  mail: {
    user: process.env.GMAIL_USER || "",
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
    otpExpiresMinutes: toNumber(process.env.OTP_EXPIRES_MINUTES, 10),
    allowSelfSigned: process.env.GMAIL_ALLOW_SELF_SIGNED === "true",
  },
};
