// Express app setup: CORS, JSON body parsing, route mounts, and error handlers.
import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { authenticate, authorizePermissions } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/authRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import postRoutes from "./routes/postRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import residentRoutes from "./routes/residentRoutes.js";
import serviceRoutes from "./routes/serviceRoutes.js";
import settingsRoutes, {
  publicSettingsRoutes,
} from "./routes/settingsRoutes.js";
import {
  announcementRoutes,
  auditLogRoutes,
  barangayRoutes,
  documentTypeRoutes,
  notificationRoutes,
  officeRoutes,
  requestRoutes,
  serviceCategoryRoutes,
  staffRoutes,
} from "./routes/moduleRoutes.js";
import { PERMISSIONS } from "./rbac/roles.js";

const app = express();

app.use(cors({ origin: env.clientOrigins, credentials: true }));
app.use(express.json());

// Public auth endpoints (login, register, password reset).
app.use("/api/auth", authRoutes);
// Public settings that the landing page can read without login.
app.use("/api/public/settings", publicSettingsRoutes);
// Dashboard APIs require login + dashboard:read.
app.use(
  "/api/dashboard",
  authenticate,
  authorizePermissions(PERMISSIONS.DASHBOARD_READ),
  dashboardRoutes,
);
app.use(
  "/api/reports",
  authenticate,
  authorizePermissions(PERMISSIONS.REPORTS_READ),
  reportRoutes,
);
app.use("/api/profile", authenticate, profileRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/posts", authenticate, postRoutes);
// Resident APIs require login + residents:read.
app.use(
  "/api/residents",
  authenticate,
  authorizePermissions(PERMISSIONS.RESIDENTS_READ),
  residentRoutes,
);
// Service APIs require login + services:read.
app.use(
  "/api/services",
  authenticate,
  authorizePermissions(PERMISSIONS.SERVICES_READ),
  serviceRoutes,
);
app.use(
  "/api/service-categories",
  authenticate,
  authorizePermissions(PERMISSIONS.SERVICE_CATEGORIES_READ),
  serviceCategoryRoutes,
);
app.use(
  "/api/document-types",
  authenticate,
  authorizePermissions(PERMISSIONS.DOCUMENT_TYPES_READ),
  documentTypeRoutes,
);
app.use(
  "/api/requests",
  authenticate,
  authorizePermissions(PERMISSIONS.REQUESTS_READ),
  requestRoutes,
);
app.use(
  "/api/barangays",
  authenticate,
  authorizePermissions(PERMISSIONS.BARANGAYS_READ),
  barangayRoutes,
);
app.use(
  "/api/offices",
  authenticate,
  authorizePermissions(PERMISSIONS.OFFICES_READ),
  officeRoutes,
);
app.use(
  "/api/staff",
  authenticate,
  authorizePermissions(PERMISSIONS.STAFF_READ),
  staffRoutes,
);
app.use(
  "/api/announcements",
  authenticate,
  authorizePermissions(PERMISSIONS.ANNOUNCEMENTS_READ),
  announcementRoutes,
);
app.use(
  "/api/notifications",
  authenticate,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_READ),
  notificationRoutes,
);
app.use(
  "/api/audit-logs",
  authenticate,
  authorizePermissions(PERMISSIONS.AUDIT_LOGS_READ),
  auditLogRoutes,
);
app.use(
  "/api/settings",
  authenticate,
  authorizePermissions(PERMISSIONS.SETTINGS_MANAGE),
  settingsRoutes,
);

// Catch unknown routes, then format any thrown errors as JSON.
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
