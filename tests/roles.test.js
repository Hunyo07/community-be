import { describe, it, expect } from 'vitest';
import {
  ROLES,
  PERMISSIONS,
  rolePermissions,
  getPermissionsForRole,
  getValidPermissions,
  normalizePermissions,
  hasPermission,
} from '../src/rbac/roles.js';

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

describe('ROLES', () => {
  it('defines the three roles', () => {
    expect(ROLES).toEqual({
      ADMIN: 'admin',
      BARANGAY_STAFF: 'barangay_staff',
      RESIDENT: 'resident',
    });
  });
});

describe('PERMISSIONS', () => {
  it('has no duplicate permission codes', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('uses the resource:action format for every code', () => {
    ALL_PERMISSIONS.forEach((code) => {
      expect(code).toMatch(/^[a-z-]+(:[a-z_-]+)+$/);
    });
  });
});

describe('rolePermissions', () => {
  it('gives admin every permission', () => {
    expect(rolePermissions[ROLES.ADMIN]).toEqual(ALL_PERMISSIONS);
  });

  it('only uses valid permission codes for every role', () => {
    Object.values(rolePermissions).forEach((list) => {
      list.forEach((code) => {
        expect(ALL_PERMISSIONS).toContain(code);
      });
    });
  });

  it('has no duplicate entries in any role', () => {
    Object.values(rolePermissions).forEach((list) => {
      expect(new Set(list).size).toBe(list.length);
    });
  });

  it('keeps admin-only permissions away from barangay staff', () => {
    const staff = rolePermissions[ROLES.BARANGAY_STAFF];
    expect(staff).not.toContain(PERMISSIONS.SETTINGS_MANAGE);
    expect(staff).not.toContain(PERMISSIONS.STAFF_WRITE);
    expect(staff).not.toContain(PERMISSIONS.AUDIT_LOGS_READ);
    expect(staff).not.toContain(PERMISSIONS.SERVICES_WRITE);
    expect(staff).not.toContain(PERMISSIONS.RESIDENTS_VIEW_ALL);
  });

  it('keeps staff-only permissions away from residents', () => {
    const resident = rolePermissions[ROLES.RESIDENT];
    expect(resident).not.toContain(PERMISSIONS.DASHBOARD_READ);
    expect(resident).not.toContain(PERMISSIONS.RESIDENTS_READ);
    expect(resident).not.toContain(PERMISSIONS.RESIDENTS_WRITE);
    expect(resident).not.toContain(PERMISSIONS.SERVICES_READ);
  });
});

describe('getPermissionsForRole', () => {
  it('returns the permission list for a known role', () => {
    const staff = getPermissionsForRole(ROLES.BARANGAY_STAFF);
    expect(staff).toContain(PERMISSIONS.DASHBOARD_READ);
    expect(staff).toContain(PERMISSIONS.REQUESTS_WRITE);
  });

  it('returns an empty list for an unknown role', () => {
    expect(getPermissionsForRole('guest')).toEqual([]);
  });

  it('returns an empty list for a missing role', () => {
    expect(getPermissionsForRole(undefined)).toEqual([]);
    expect(getPermissionsForRole(null)).toEqual([]);
  });
});

describe('getValidPermissions', () => {
  it('returns every permission code', () => {
    expect(getValidPermissions()).toEqual(ALL_PERMISSIONS);
  });
});

describe('normalizePermissions', () => {
  it('always gives residents their default permissions', () => {
    expect(
      normalizePermissions([PERMISSIONS.DASHBOARD_READ], ROLES.RESIDENT),
    ).toEqual(rolePermissions[ROLES.RESIDENT]);
  });

  it('returns a copy for residents so the defaults cannot be changed', () => {
    const result = normalizePermissions(undefined, ROLES.RESIDENT);
    result.push('fake:permission');
    expect(rolePermissions[ROLES.RESIDENT]).not.toContain('fake:permission');
  });

  it('keeps valid permissions and removes unknown ones', () => {
    expect(
      normalizePermissions(
        [PERMISSIONS.PROFILE_READ, 'fake:perm', PERMISSIONS.RESIDENTS_READ],
        ROLES.ADMIN,
      ),
    ).toEqual([PERMISSIONS.PROFILE_READ, PERMISSIONS.RESIDENTS_READ]);
  });

  it('removes duplicate permissions', () => {
    expect(
      normalizePermissions(
        [PERMISSIONS.PROFILE_READ, PERMISSIONS.PROFILE_READ],
        ROLES.ADMIN,
      ),
    ).toEqual([PERMISSIONS.PROFILE_READ]);
  });

  it('reads permissions from a JSON string', () => {
    expect(
      normalizePermissions('["profile:read","residents:read"]', ROLES.ADMIN),
    ).toEqual([PERMISSIONS.PROFILE_READ, PERMISSIONS.RESIDENTS_READ]);
  });

  it('gives no permissions when the JSON string is broken', () => {
    expect(normalizePermissions('not json', ROLES.ADMIN)).toEqual([]);
  });

  it('gives no permissions for an empty string', () => {
    expect(normalizePermissions('', ROLES.ADMIN)).toEqual([]);
  });

  it('falls back to the role defaults when permissions are undefined', () => {
    expect(normalizePermissions(undefined, ROLES.BARANGAY_STAFF)).toEqual(
      rolePermissions[ROLES.BARANGAY_STAFF],
    );
  });

  it('falls back to the role defaults when permissions are null', () => {
    expect(normalizePermissions(null, ROLES.ADMIN)).toEqual(ALL_PERMISSIONS);
  });

  it('falls back to the role defaults when the JSON is not a list', () => {
    expect(normalizePermissions('{"a":1}', ROLES.ADMIN)).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it('gives no permissions for an unknown role with no list', () => {
    expect(normalizePermissions(undefined, 'guest')).toEqual([]);
  });

  it('keeps an empty list empty', () => {
    expect(normalizePermissions([], ROLES.ADMIN)).toEqual([]);
  });

  it('adds directory access for staff who can read services', () => {
    expect(
      normalizePermissions([PERMISSIONS.SERVICES_READ], ROLES.BARANGAY_STAFF),
    ).toEqual([
      PERMISSIONS.SERVICES_READ,
      PERMISSIONS.SERVICES_DIRECTORY_READ,
    ]);
  });

  it('does not duplicate directory access for staff', () => {
    expect(
      normalizePermissions(
        [PERMISSIONS.SERVICES_READ, PERMISSIONS.SERVICES_DIRECTORY_READ],
        ROLES.BARANGAY_STAFF,
      ),
    ).toEqual([
      PERMISSIONS.SERVICES_READ,
      PERMISSIONS.SERVICES_DIRECTORY_READ,
    ]);
  });

  it('does not add directory access for admins', () => {
    expect(
      normalizePermissions([PERMISSIONS.SERVICES_READ], ROLES.ADMIN),
    ).toEqual([PERMISSIONS.SERVICES_READ]);
  });

  it('does not change the list that was passed in', () => {
    const input = [PERMISSIONS.SERVICES_READ];
    normalizePermissions(input, ROLES.BARANGAY_STAFF);
    expect(input).toEqual([PERMISSIONS.SERVICES_READ]);
  });
});

describe('hasPermission', () => {
  it('lets the admin role do everything', () => {
    ALL_PERMISSIONS.forEach((code) => {
      expect(hasPermission(ROLES.ADMIN, code)).toBe(true);
    });
  });

  it('lets the resident role use its own permissions', () => {
    expect(hasPermission(ROLES.RESIDENT, PERMISSIONS.PROFILE_READ)).toBe(true);
    expect(hasPermission(ROLES.RESIDENT, PERMISSIONS.REQUESTS_WRITE)).toBe(
      true,
    );
  });

  it('blocks the resident role from staff permissions', () => {
    expect(hasPermission(ROLES.RESIDENT, PERMISSIONS.DASHBOARD_READ)).toBe(
      false,
    );
    expect(hasPermission(ROLES.RESIDENT, PERMISSIONS.SETTINGS_MANAGE)).toBe(
      false,
    );
  });

  it('denies everything to an unknown role', () => {
    expect(hasPermission('guest', PERMISSIONS.PROFILE_READ)).toBe(false);
  });

  it('uses the permissions saved on a user object', () => {
    const user = {
      role: ROLES.BARANGAY_STAFF,
      permissions: [PERMISSIONS.REPORTS_READ],
    };
    expect(hasPermission(user, PERMISSIONS.REPORTS_READ)).toBe(true);
    expect(hasPermission(user, PERMISSIONS.DASHBOARD_READ)).toBe(false);
  });

  it('uses the role defaults when a user has no saved permissions', () => {
    const user = { role: ROLES.BARANGAY_STAFF };
    expect(hasPermission(user, PERMISSIONS.DASHBOARD_READ)).toBe(true);
    expect(hasPermission(user, PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
  });

  it('does not let a resident gain extra permissions', () => {
    const user = {
      role: ROLES.RESIDENT,
      permissions: [PERMISSIONS.SETTINGS_MANAGE],
    };
    expect(hasPermission(user, PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
    expect(hasPermission(user, PERMISSIONS.PROFILE_READ)).toBe(true);
  });

  it('gives directory access to staff who can read services', () => {
    const user = {
      role: ROLES.BARANGAY_STAFF,
      permissions: [PERMISSIONS.SERVICES_READ],
    };
    expect(hasPermission(user, PERMISSIONS.SERVICES_DIRECTORY_READ)).toBe(true);
  });

  it('reads permissions stored as a JSON string', () => {
    const user = {
      role: ROLES.ADMIN,
      permissions: '["reports:read"]',
    };
    expect(hasPermission(user, PERMISSIONS.REPORTS_READ)).toBe(true);
    expect(hasPermission(user, PERMISSIONS.DASHBOARD_READ)).toBe(false);
  });

  it('denies everything for null', () => {
    expect(hasPermission(null, PERMISSIONS.PROFILE_READ)).toBe(false);
  });

  it('denies everything for undefined', () => {
    expect(hasPermission(undefined, PERMISSIONS.PROFILE_READ)).toBe(false);
  });
});