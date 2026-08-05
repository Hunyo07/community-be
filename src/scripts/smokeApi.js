// Quick API smoke test: hits health, login, and key list endpoints for each role.
import { env } from '../config/env.js';

const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${env.port}/api`;
const seededEmail = process.env.SMOKE_EMAIL || 'admin@community.test';
const seededPassword = process.env.SMOKE_PASSWORD || 'Resident@123';

// Call an API path and optionally assert the HTTP status code.
const requestJson = async (path, options = {}, expectedStatus = null) => {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));

  if (expectedStatus !== null) {
    if (response.status !== expectedStatus) {
      throw new Error(`${options.method || 'GET'} ${path} expected ${expectedStatus} but got ${response.status}`);
    }

    return data;
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${data.message || data.details || response.statusText}`);
  }

  return data;
};

// Ensures a list endpoint returned { data: [...] }.
const assertArrayResponse = (label, response) => {
  if (!Array.isArray(response.data)) {
    throw new Error(`${label} did not return a data array`);
  }
};

// Log in and return Authorization headers for later requests.
const loginAs = async (email, password = seededPassword) => {
  const loginResponse = await requestJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  const token = loginResponse.data?.token;

  if (!token) {
    throw new Error(`Login for ${email} did not return a token`);
  }

  return { Authorization: `Bearer ${token}` };
};

// Run role-based checks for admin, staff, and resident accounts.
const smokeApi = async () => {
  console.log(`API smoke target: ${apiBaseUrl}`);

  await requestJson('/health');
  await requestJson('/public/settings');

  const adminHeaders = await loginAs(seededEmail);
  await requestJson('/auth/me', { headers: adminHeaders });
  await requestJson('/dashboard', { headers: adminHeaders });

  const listChecks = [
    ['/residents', 'Residents'],
    ['/services', 'Services'],
    ['/service-categories', 'Service categories'],
    ['/requests', 'Requests'],
    ['/document-types', 'Document types'],
    ['/barangays', 'Barangays'],
    ['/offices', 'Offices'],
    ['/staff', 'Staff'],
    ['/announcements', 'Announcements'],
    ['/notifications', 'Notifications'],
    ['/audit-logs', 'Audit logs'],
    ['/settings', 'Settings']
  ];

  for (const [path, label] of listChecks) {
    assertArrayResponse(label, await requestJson(path, { headers: adminHeaders }));
  }

  const staffHeaders = await loginAs(process.env.SMOKE_STAFF_EMAIL || 'sanisidro.staff@community.test');
  await requestJson('/dashboard', { headers: staffHeaders });
  assertArrayResponse('Staff residents', await requestJson('/residents', { headers: staffHeaders }));
  assertArrayResponse('Staff services', await requestJson('/services', { headers: staffHeaders }));
  assertArrayResponse('Staff service directory', await requestJson('/services/directory', { headers: staffHeaders }));
  assertArrayResponse('Staff requests', await requestJson('/requests', { headers: staffHeaders }));
  assertArrayResponse('Staff document types', await requestJson('/document-types', { headers: staffHeaders }));
  await requestJson('/staff', { headers: staffHeaders }, 403);
  await requestJson('/settings', { headers: staffHeaders }, 403);
  await requestJson('/audit-logs', { headers: staffHeaders }, 403);

  const residentHeaders = await loginAs(process.env.SMOKE_RESIDENT_EMAIL || 'maria.santos@community.test');
  await requestJson('/profile', { headers: residentHeaders });
  assertArrayResponse('Resident requests', await requestJson('/requests', { headers: residentHeaders }));
  assertArrayResponse('Resident document types', await requestJson('/document-types', { headers: residentHeaders }));
  assertArrayResponse('Resident announcements', await requestJson('/announcements', { headers: residentHeaders }));
  assertArrayResponse('Resident notifications', await requestJson('/notifications', { headers: residentHeaders }));
  await requestJson('/dashboard', { headers: residentHeaders }, 403);
  await requestJson('/services', { headers: residentHeaders }, 403);
  await requestJson('/residents', { headers: residentHeaders }, 403);
  await requestJson('/staff', { headers: residentHeaders }, 403);
  await requestJson('/settings', { headers: residentHeaders }, 403);

  console.log('API smoke check passed.');
};

smokeApi().catch((error) => {
  console.error('API smoke check failed.');
  console.error(error.message);
  console.error('Start the API with npm run start and seed users with npm run seed:users before running this check.');
  process.exitCode = 1;
});
