import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve .env next to the backend package so PM2's working directory does not matter.
const envFileUrl = new URL("../../.env", import.meta.url);
const envPath = fileURLToPath(envFileUrl);
const envResult = dotenv.config({ path: envFileUrl, quiet: true });

if (envResult.error) {
  throw new Error(
    `Could not load environment file at ${envPath}: ${envResult.error.message}`,
  );
}

const requiredEnvKeys = [
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "JWT_SECRET",
];
const missingEnvKeys = requiredEnvKeys.filter(
  (key) => process.env[key] === undefined || process.env[key] === "",
);

if (missingEnvKeys.length > 0) {
  throw new Error(
    `Missing ${missingEnvKeys.join(", ")} after loading ${envPath}. Set these keys in that file before starting the API.`,
  );
}

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
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  db: {
    host: process.env.DB_HOST,
    port: toNumber(process.env.DB_PORT, 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  mail: {
    user: process.env.GMAIL_USER || "",
    appPassword: process.env.GMAIL_APP_PASSWORD || "",
    otpExpiresMinutes: toNumber(process.env.OTP_EXPIRES_MINUTES, 10),
    allowSelfSigned: process.env.GMAIL_ALLOW_SELF_SIGNED === "true",
  },
};
