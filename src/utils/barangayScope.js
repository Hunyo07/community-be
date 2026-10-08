// Decides whether a signed-in user manages one barangay or the whole city.
import { PERMISSIONS, ROLES } from '../rbac/roles.js';

export const assignedBarangay = (user) => String(user?.barangay ?? '').trim();

// City-wide only when the admin role has no barangay assignment.
export const isCityWideAdmin = (user) =>
  user?.role === ROLES.ADMIN && !assignedBarangay(user);

// An admin who belongs to one barangay manages that barangay only.
export const isBarangayAdmin = (user) =>
  user?.role === ROLES.ADMIN && Boolean(assignedBarangay(user));

// Staff and barangay admins operate inside one barangay. City-wide admins do not.
export const managesSingleBarangay = (user) =>
  isBarangayAdmin(user) || user?.role === ROLES.BARANGAY_STAFF;

// True when resident-style lists must be limited to the user's barangay.
// A view-all permission still widens barangay staff. It does not widen a barangay admin.
export const isOperationallyScoped = (user, viewAllPermission = PERMISSIONS.RESIDENTS_VIEW_ALL) => {
  if (!user || user.role === ROLES.RESIDENT || user.accountType === 'resident') return false;
  if (isCityWideAdmin(user)) return false;
  if (isBarangayAdmin(user)) return true;
  if (user.role === ROLES.BARANGAY_STAFF) {
    return !user.permissions?.includes(viewAllPermission);
  }
  return Boolean(assignedBarangay(user));
};
