import { Router } from "express";
import {
  createResident,
  getResidentSelfieId,
  getResidents,
  updateResident,
  updateResidentStatus,
} from "../controllers/residentController.js";
import { authorizePermissions } from "../middleware/auth.js";
import { uploadResidentId } from "../middleware/upload.js";
import { PERMISSIONS } from "../rbac/roles.js";

// These routes expose resident-related endpoints for listing, creating, updating, and reviewing residents.
const router = Router();

// List residents (scoped by the caller's barangay permissions inside the controller).
router.get("/", getResidents);
// Create a resident account and optionally upload a selfie-with-ID image.
router.post(
  "/",
  authorizePermissions(PERMISSIONS.RESIDENTS_WRITE),
  uploadResidentId.single("selfieWithId"),
  createResident,
);
// Return the uploaded selfie-with-ID file for staff review.
router.get(
  "/:id/selfie-id",
  authorizePermissions(PERMISSIONS.RESIDENTS_READ),
  getResidentSelfieId,
);
// Update resident profile fields and optional selfie or password.
router.patch(
  "/:id",
  authorizePermissions(PERMISSIONS.RESIDENTS_WRITE),
  uploadResidentId.single("selfieWithId"),
  updateResident,
);
// Change verification or account status after staff review.
router.patch(
  "/:id/status",
  authorizePermissions(PERMISSIONS.RESIDENTS_WRITE),
  updateResidentStatus,
);

export default router;
