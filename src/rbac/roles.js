// Backend RBAC map: roles, permission codes, defaults, and permission helpers.
export const ROLES = {
  ADMIN: 'admin',
  BARANGAY_STAFF: 'barangay_staff',
  RESIDENT: 'resident'
};

// Permission codes checked by middleware and controllers.
export const PERMISSIONS = {
  DASHBOARD_READ: 'dashboard:read',
  PROFILE_READ: 'profile:read',
  PROFILE_WRITE: 'profile:write',
  RESIDENTS_READ: 'residents:read',
  RESIDENTS_WRITE: 'residents:write',
  RESIDENTS_VIEW_ALL: 'residents:view_all',
  SERVICES_READ: 'services:read',
  SERVICES_DIRECTORY_READ: 'services:directory:read',
  SERVICES_WRITE: 'services:write',
  SERVICES_ASSIGN_OFFICE: 'services:assign_office',
  SERVICE_CATEGORIES_READ: 'service-categories:read',
  SERVICE_CATEGORIES_WRITE: 'service-categories:write',
  SERVICES_VIEW_ALL_OFFICES: 'services:view_all_offices',
  SERVICES_VIEW_ALL_BARANGAYS: 'services:view_all_barangays',
  REQUESTS_READ: 'requests:read',
  REQUESTS_WRITE: 'requests:write',
  DOCUMENT_TYPES_READ: 'document-types:read',
  DOCUMENT_TYPES_WRITE: 'document-types:write',
  BARANGAYS_READ: 'barangays:read',
  BARANGAYS_WRITE: 'barangays:write',
  OFFICES_READ: 'offices:read',
  OFFICES_WRITE: 'offices:write',
  OFFICES_ASSIGN_STAFF: 'offices:assign_staff',
  STAFF_READ: 'staff:read',
  STAFF_WRITE: 'staff:write',
  STAFF_ASSIGN_OFFICE: 'staff:assign_office',
  REPORTS_READ: 'reports:read',
  ANNOUNCEMENTS_READ: 'announcements:read',
  ANNOUNCEMENTS_WRITE: 'announcements:write',
  NOTIFICATIONS_READ: 'notifications:read',
  AUDIT_LOGS_READ: 'audit-logs:read',
  SETTINGS_MANAGE: 'settings:manage'
};

// Default permissions granted to each role.
export const rolePermissions = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.BARANGAY_STAFF]: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.PROFILE_READ,
    PERMISSIONS.PROFILE_WRITE,
    PERMISSIONS.RESIDENTS_READ,
    PERMISSIONS.RESIDENTS_WRITE,
    PERMISSIONS.SERVICES_READ,
    PERMISSIONS.SERVICES_DIRECTORY_READ,
    PERMISSIONS.SERVICE_CATEGORIES_READ,
    PERMISSIONS.REQUESTS_READ,
    PERMISSIONS.REQUESTS_WRITE,
    PERMISSIONS.DOCUMENT_TYPES_READ,
    PERMISSIONS.BARANGAYS_READ,
    PERMISSIONS.OFFICES_READ,
    PERMISSIONS.ANNOUNCEMENTS_READ,
    PERMISSIONS.NOTIFICATIONS_READ
  ],
  [ROLES.RESIDENT]: [
    PERMISSIONS.PROFILE_READ,
    PERMISSIONS.PROFILE_WRITE,
    PERMISSIONS.REQUESTS_READ,
    PERMISSIONS.REQUESTS_WRITE,
    PERMISSIONS.DOCUMENT_TYPES_READ,
    PERMISSIONS.ANNOUNCEMENTS_READ,
    PERMISSIONS.NOTIFICATIONS_READ
  ]
};

// Returns the default permission list for a role name.
export const getPermissionsForRole = (role) => rolePermissions[role] || [];

// Returns every valid permission code in the system.
export const getValidPermissions = () => Object.values(PERMISSIONS);

// Cleans a stored permission list and applies role-specific rules (e.g. residents).
export const normalizePermissions = (permissions, role) => {
  if (role === ROLES.RESIDENT) {
    return [...rolePermissions[ROLES.RESIDENT]];
  }

  const validPermissions = new Set(getValidPermissions());
  let parsedPermissions = permissions;

  if (typeof permissions === 'string') {
    try {
      parsedPermissions = JSON.parse(permissions || '[]');
    } catch {
      parsedPermissions = [];
    }
  }

  const source = Array.isArray(parsedPermissions) ? parsedPermissions : getPermissionsForRole(role);
  const normalized = source.filter((permission) => validPermissions.has(permission));

  if (role === ROLES.BARANGAY_STAFF && normalized.includes(PERMISSIONS.SERVICES_READ)) {
    normalized.push(PERMISSIONS.SERVICES_DIRECTORY_READ);
  }

  return Array.from(new Set(normalized));
};

// Checks whether a user object or role string includes a permission.
export const hasPermission = (userOrRole, permission) => {
  if (typeof userOrRole === 'string') {
    return getPermissionsForRole(userOrRole).includes(permission);
  }

  return normalizePermissions(userOrRole?.permissions, userOrRole?.role).includes(permission);
};
