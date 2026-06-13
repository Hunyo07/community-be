import { pool } from '../config/db.js';
import { emitRealtimeEvent } from '../realtime/socket.js';
import { logAudit } from '../utils/auditLogger.js';
import { getSettingValue } from '../utils/settings.js';

const mapService = (service) => ({
  id: `SRV-${String(service.id).padStart(3, '0')}`,
  rawId: service.id,
  name: service.name,
  category: service.category,
  barangay: service.barangay,
  description: service.description || '',
  targetScope: service.target_scope || 'All Residents',
  startDate: service.start_date ? String(service.start_date).slice(0, 10) : '',
  endDate: service.end_date ? String(service.end_date).slice(0, 10) : '',
  remarks: service.remarks || '',
  beneficiaries: Number(service.served_count ?? service.beneficiaries ?? 0),
  officeId: service.office_id,
  officeName: service.office_name || '',
  visibility: service.visibility,
  targetBeneficiaries: Number(service.target_residents ?? service.target_beneficiaries ?? 0),
  requests: service.pending_requests,
  remainingBeneficiaries: Math.max(Number(service.target_residents ?? service.target_beneficiaries ?? 0) - Number(service.served_count ?? service.beneficiaries ?? 0), 0),
  beneficiaryProgress: Number(service.target_residents ?? service.target_beneficiaries ?? 0)
    ? Math.min(100, Math.round((Number(service.served_count ?? service.beneficiaries ?? 0) / Number(service.target_residents ?? service.target_beneficiaries ?? 0)) * 100))
    : 0,
  status: service.status,
  createdAt: service.created_at
});

const allowedStatuses = ['Active', 'Inactive', 'Completed'];
const allowedBeneficiaryStatuses = ['Pending', 'Served', 'Skipped', 'Not Eligible'];
const allowedVisibility = ['own_barangay', 'all_barangays', 'public'];

const escapeCsvValue = (value) => {
  const stringValue = value === null || value === undefined ? '' : String(value);
  if (!/[",\n\r]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('"', '""')}"`;
};

const rowsToCsv = (columns, rows) => {
  const header = columns.map((column) => escapeCsvValue(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsvValue(row[column.key])).join(','));
  return [header, ...body].join('\n');
};

const sendCsv = (res, filename, columns, rows) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(`\uFEFF${rowsToCsv(columns, rows)}`);
};

const slugify = (value) =>
  String(value || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'export';

const todayStamp = () => new Date().toISOString().slice(0, 10);
const serviceSelect = `
  SELECT services.id, services.name, services.category, services.barangay, services.office_id, offices.name AS office_name,
    services.visibility, services.description, services.target_scope, services.start_date, services.end_date, services.remarks,
    services.target_beneficiaries, COALESCE(served.served_count, 0) AS served_count,
    COALESCE(targets.target_residents, 0) AS target_residents, services.pending_requests, services.status, services.created_at
  FROM services
  LEFT JOIN offices ON offices.id = services.office_id
  LEFT JOIN (
    SELECT service_id, COUNT(*) AS served_count
    FROM service_beneficiaries
    WHERE status = 'Served'
    GROUP BY service_id
  ) served ON served.service_id = services.id
  LEFT JOIN (
    SELECT s.id AS service_id, COUNT(ra.id) AS target_residents
    FROM services s
    LEFT JOIN resident_accounts ra ON ra.barangay = s.barangay
      AND (s.target_scope != 'Senior Citizens' OR ra.age >= 60)
    GROUP BY s.id
  ) targets ON targets.service_id = services.id
`;

const getActiveServiceCategories = async () => {
  const [rows] = await pool.query(`SELECT name FROM service_categories WHERE status = 'Active'`);
  return rows.map((row) => row.name);
};

const getOfficeById = async (id) => {
  if (!id) return null;

  const [rows] = await pool.execute('SELECT id, barangay, status FROM offices WHERE id = ?', [id]);
  return rows[0] || null;
};

const getServiceById = async (id) => {
  const [rows] = await pool.execute(
    `${serviceSelect}
     WHERE services.id = ?`,
    [id]
  );

  return rows[0] ? mapService(rows[0]) : null;
};

const assertServiceAccess = (req, service) => {
  if (!service || req.user?.role !== 'barangay_staff') return null;

  const sameBarangay = service.barangay === req.user.barangay;
  const sameOffice = !service.officeId || service.officeId === req.user.officeId;
  const canViewAllOffices = req.user.permissions?.includes('services:view_all_offices');

  if (!sameBarangay || (!sameOffice && !canViewAllOffices)) {
    return Object.assign(new Error('You do not have permission to manage this service'), { statusCode: 403 });
  }

  return null;
};

const assertWritableServiceScope = (req, payload) => {
  if (req.user?.role !== 'barangay_staff') return null;

  const sameBarangay = payload.barangay === req.user.barangay;
  const sameOffice = !payload.officeId || payload.officeId === req.user.officeId;
  const canViewAllOffices = req.user.permissions?.includes('services:view_all_offices');
  const canAssignOffice = req.user.permissions?.includes('services:assign_office');

  if (!sameBarangay) {
    return Object.assign(new Error('Barangay staff can only manage services in their assigned barangay'), { statusCode: 403 });
  }

  if (!sameOffice && !canViewAllOffices && !canAssignOffice) {
    return Object.assign(new Error('Barangay staff can only manage services in their assigned office'), { statusCode: 403 });
  }

  return null;
};

const applyStaffOfficeScope = async (req, payload) => {
  if (req.user?.role !== 'barangay_staff') return payload;

  const canAssignOffice = req.user.permissions?.includes('services:assign_office');

  if (!canAssignOffice) {
    return {
      ...payload,
      officeId: req.user.officeId || null
    };
  }

  if (!payload.officeId) {
    return payload;
  }

  const office = await getOfficeById(payload.officeId);
  if (!office || office.status !== 'Active') {
    throw Object.assign(new Error('Selected office is not available'), { statusCode: 400 });
  }

  if (office.barangay !== req.user.barangay) {
    throw Object.assign(new Error('Barangay staff can only assign services to offices in their assigned barangay'), { statusCode: 403 });
  }

  return payload;
};

const getScopedServices = async (req) => {
  const filters = [];
  const values = [];

  if (req.user?.role === 'barangay_staff') {
    if (!req.user.permissions?.includes('services:view_all_barangays')) {
      filters.push('services.barangay = ?');
      values.push(req.user.barangay || '');
    }

    if (!req.user.permissions?.includes('services:view_all_offices') && !req.user.permissions?.includes('services:view_all_barangays')) {
      filters.push('(services.office_id = ? OR services.office_id IS NULL)');
      values.push(req.user.officeId || 0);
    }
  }

  if (req.user?.role === 'resident') {
    filters.push(`(services.barangay = ? OR services.visibility IN ('all_barangays', 'public'))`);
    values.push(req.user.barangay || '');
    filters.push(`services.status = 'Active'`);
  }

  const search = req.query.search?.trim();
  if (search) {
    filters.push('(services.name LIKE ? OR services.category LIKE ? OR services.barangay LIKE ?)');
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (req.query.category) {
    filters.push('services.category = ?');
    values.push(req.query.category);
  }
  if (req.query.status) {
    filters.push('services.status = ?');
    values.push(req.query.status);
  }
  if (req.query.barangay) {
    filters.push('services.barangay = ?');
    values.push(req.query.barangay);
  }

  const scopedWhereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `${serviceSelect}
     ${scopedWhereClause}
     ORDER BY services.created_at DESC`,
    values
  );
  let services = rows.map(mapService);

  if (req.query.coverage) {
    services = services.filter(
      (service) =>
        (req.query.coverage === 'not_started' && Number(service.beneficiaries || 0) === 0) ||
        (req.query.coverage === 'in_progress' && Number(service.beneficiaryProgress || 0) > 0 && Number(service.beneficiaryProgress || 0) < 100) ||
        (req.query.coverage === 'complete' && Number(service.beneficiaryProgress || 0) >= 100)
    );
  }

  return services;
};

const normalizeServicePayload = async (body, existing = {}, defaults = {}) => {
  const payload = {
    name: body.name ?? existing.name,
    category: body.category ?? existing.category,
    barangay: defaults.barangay ?? body.barangay ?? existing.barangay ?? 'All Barangays',
    officeId: body.officeId ?? existing.officeId ?? null,
    visibility: body.visibility ?? existing.visibility ?? defaults.visibility ?? 'own_barangay',
    description: body.description ?? existing.description ?? '',
    targetScope: body.targetScope ?? existing.targetScope ?? 'All Residents',
    startDate: body.startDate === '' ? null : body.startDate ?? existing.startDate ?? null,
    endDate: body.endDate === '' ? null : body.endDate ?? existing.endDate ?? null,
    remarks: body.remarks ?? existing.remarks ?? '',
    targetBeneficiaries: body.targetBeneficiaries ?? existing.targetBeneficiaries ?? 0,
    pendingRequests: body.pendingRequests ?? existing.requests ?? 0,
    status: body.status ?? existing.status ?? 'Active'
  };

  if (!payload.name || !payload.category || !payload.barangay || payload.barangay === 'All Barangays') {
    throw Object.assign(new Error('Name, category, and assigned barangay are required'), { statusCode: 400 });
  }

  const allowedCategories = await getActiveServiceCategories();
  if (!allowedCategories.includes(payload.category)) {
    throw Object.assign(new Error('Invalid service category'), { statusCode: 400 });
  }

  if (!allowedStatuses.includes(payload.status)) {
    throw Object.assign(new Error('Invalid service status'), { statusCode: 400 });
  }

  if (!allowedVisibility.includes(payload.visibility)) {
    throw Object.assign(new Error('Invalid service visibility'), { statusCode: 400 });
  }

  payload.targetBeneficiaries = Number(payload.targetBeneficiaries || 0);
  payload.pendingRequests = Number(payload.pendingRequests || 0);

  if (payload.targetBeneficiaries < 0 || payload.pendingRequests < 0) {
    throw Object.assign(new Error('Beneficiary counts must be zero or greater'), { statusCode: 400 });
  }

  return payload;
};

export const getServices = async (req, res, next) => {
  try {
    const services = await getScopedServices(req);
    return res.json({ data: services });
  } catch (error) {
    return next(error);
  }
};

export const getServiceDirectory = async (req, res, next) => {
  try {
    const filters = [`services.visibility IN ('all_barangays', 'public')`];
    const values = [];

    if (req.user?.role === 'resident') {
      filters.push(`services.visibility = 'public'`);
      filters.push(`services.status = 'Active'`);
    }

    const search = req.query.search?.trim();
    if (search) {
      filters.push('(services.name LIKE ? OR services.category LIKE ? OR services.barangay LIKE ? OR offices.name LIKE ?)');
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (req.query.category) {
      filters.push('services.category = ?');
      values.push(req.query.category);
    }

    if (req.query.status) {
      filters.push('services.status = ?');
      values.push(req.query.status);
    }

    if (req.query.barangay) {
      filters.push('services.barangay = ?');
      values.push(req.query.barangay);
    }

    if (req.query.visibility && allowedVisibility.includes(req.query.visibility)) {
      filters.push('services.visibility = ?');
      values.push(req.query.visibility);
    }

    const [rows] = await pool.execute(
      `${serviceSelect}
       WHERE ${filters.join(' AND ')}
       ORDER BY services.created_at DESC`,
      values
    );

    return res.json({ data: rows.map(mapService) });
  } catch (error) {
    return next(error);
  }
};

export const createService = async (req, res, next) => {
  try {
    const defaultVisibility = await getSettingValue('default_service_visibility', 'own_barangay');
    let payload = await normalizeServicePayload(req.body, {}, {
      visibility: defaultVisibility,
      barangay: req.user?.role === 'barangay_staff' ? req.user.barangay : undefined
    });
    payload = await applyStaffOfficeScope(req, payload);
    const scopeError = assertWritableServiceScope(req, payload);
    if (scopeError) throw scopeError;

    const { name, category, barangay, officeId, visibility, description, targetScope, startDate, endDate, remarks, targetBeneficiaries, pendingRequests, status } = payload;

    const [result] = await pool.execute(
      `INSERT INTO services (name, category, barangay, office_id, visibility, description, target_scope, start_date, end_date, remarks, target_beneficiaries, beneficiaries, pending_requests, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [name, category, barangay, officeId, visibility, description, targetScope, startDate, endDate, remarks, targetBeneficiaries, pendingRequests, status]
    );

    const [rows] = await pool.execute(
      `${serviceSelect}
       WHERE services.id = ?`,
      [result.insertId]
    );
    const service = mapService(rows[0]);

    await logAudit({ user: req.user, action: 'services.create', entityType: 'services', entityId: result.insertId, details: service });
    emitRealtimeEvent('services:changed', { action: 'created', data: service });
    emitRealtimeEvent('dashboard:changed', { reason: 'service-created' });

    return res.status(201).json({ data: service });
  } catch (error) {
    return next(error);
  }
};

export const updateService = async (req, res, next) => {
  try {
    const existing = await getServiceById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Service not found' });

    const accessError = assertServiceAccess(req, existing);
    if (accessError) throw accessError;

    let payload = await normalizeServicePayload(req.body, existing, {
      barangay: req.user?.role === 'barangay_staff' ? req.user.barangay : undefined
    });
    payload = await applyStaffOfficeScope(req, payload);
    const scopeError = assertWritableServiceScope(req, payload);
    if (scopeError) throw scopeError;

    const { name, category, barangay, officeId, visibility, description, targetScope, startDate, endDate, remarks, targetBeneficiaries, pendingRequests, status } = payload;

    await pool.execute(
      `UPDATE services
       SET name = ?, category = ?, barangay = ?, office_id = ?, visibility = ?, description = ?, target_scope = ?, start_date = ?, end_date = ?, remarks = ?, target_beneficiaries = ?, pending_requests = ?, status = ?
       WHERE id = ?`,
      [name, category, barangay, officeId || null, visibility, description, targetScope, startDate, endDate, remarks, targetBeneficiaries, pendingRequests, status, req.params.id]
    );

    const service = await getServiceById(req.params.id);

    await logAudit({ user: req.user, action: 'services.update', entityType: 'services', entityId: req.params.id, details: req.body });
    emitRealtimeEvent('services:changed', { action: 'updated', data: service });
    emitRealtimeEvent('dashboard:changed', { reason: 'service-updated' });

    return res.json({ data: service });
  } catch (error) {
    return next(error);
  }
};

const getServiceForAction = async (req, id) => {
  const service = await getServiceById(id);
  if (!service) {
    throw Object.assign(new Error('Service not found'), { statusCode: 404 });
  }
  const accessError = assertServiceAccess(req, service);
  if (accessError) throw accessError;
  return service;
};

const mapChecklistResident = (row) => ({
  residentId: row.resident_id,
  residentCode: `RES-${String(row.resident_id).padStart(4, '0')}`,
  name: `${row.first_name} ${row.last_name}`,
  barangay: row.barangay,
  age: row.age || null,
  gender: row.gender || 'Unspecified',
  purokSitio: row.purok_sitio || '',
  contactNumber: row.contact_number || row.email || '',
  beneficiaryStatus: row.beneficiary_status || 'Not Served',
  dateServed: row.served_at,
  processedBy: row.processed_by_name || '',
  remarks: row.remarks || ''
});

const getServiceChecklistRows = async (service, filters = {}) => {
  const where = ['ra.barangay = ?'];
  const values = [service.barangay];

  if (filters.search) {
    where.push(`(ra.first_name LIKE ? OR ra.last_name LIKE ? OR ra.email LIKE ?)`);
    values.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }

  if (filters.purok) {
    where.push('ra.purok_sitio = ?');
    values.push(filters.purok);
  }

  if (filters.gender) {
    where.push('ra.gender = ?');
    values.push(filters.gender);
  }

  const [rows] = await pool.execute(
    `SELECT ra.id AS resident_id, ra.first_name, ra.last_name, ra.email, ra.contact_number, ra.barangay,
            ra.age, ra.gender, ra.purok_sitio, sb.status AS beneficiary_status,
            sb.served_at, sb.processed_by_name, sb.remarks
     FROM resident_accounts ra
     LEFT JOIN service_beneficiaries sb ON sb.resident_id = ra.id AND sb.service_id = ?
     WHERE ${where.join(' AND ')}
     ORDER BY ra.last_name ASC, ra.first_name ASC`,
    [service.rawId, ...values]
  );

  let mapped = rows.map(mapChecklistResident);

  if (filters.status) {
    mapped = mapped.filter((resident) => resident.beneficiaryStatus === filters.status);
  }

  if (filters.ageGroup) {
    mapped = mapped.filter((resident) => {
      const age = Number(resident.age || 0);
      if (filters.ageGroup === 'Youth') return age <= 24;
      if (filters.ageGroup === 'Senior') return age >= 60;
      return age >= 25 && age < 60;
    });
  }

  if (service.targetScope === 'Senior Citizens') {
    mapped = mapped.filter((resident) => Number(resident.age || 0) >= 60);
  }

  return mapped;
};

const getServiceSummary = async (service) => {
  const rows = await getServiceChecklistRows(service, {});
  const totalResidents = rows.length;
  const served = rows.filter((row) => row.beneficiaryStatus === 'Served').length;
  const pending = rows.filter((row) => row.beneficiaryStatus === 'Pending').length;
  const skipped = rows.filter((row) => row.beneficiaryStatus === 'Skipped').length;
  const notEligible = rows.filter((row) => row.beneficiaryStatus === 'Not Eligible').length;
  const notYetServed = Math.max(totalResidents - served, 0);

  return {
    totalResidents,
    totalBeneficiaries: served,
    notYetServed,
    pending,
    skipped,
    notEligible,
    completionRate: totalResidents ? Math.round((served / totalResidents) * 100) : 0
  };
};

const formatCsvDate = (value) => {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
};

const serviceSummaryColumns = [
  { key: 'id', label: 'Service ID' },
  { key: 'name', label: 'Service Name' },
  { key: 'category', label: 'Category' },
  { key: 'barangay', label: 'Barangay' },
  { key: 'officeName', label: 'Office' },
  { key: 'targetScope', label: 'Target Scope' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'endDate', label: 'End Date' },
  { key: 'targetBeneficiaries', label: 'Target Residents' },
  { key: 'beneficiaries', label: 'Served Count' },
  { key: 'remainingBeneficiaries', label: 'Not Yet Served Count' },
  { key: 'beneficiaryProgress', label: 'Completion Rate' },
  { key: 'status', label: 'Status' },
  { key: 'remarks', label: 'Remarks' }
];

const serviceResidentColumns = [
  { key: 'serviceName', label: 'Service Name' },
  { key: 'serviceId', label: 'Service ID' },
  { key: 'category', label: 'Category' },
  { key: 'barangay', label: 'Barangay' },
  { key: 'residentCode', label: 'Resident ID' },
  { key: 'name', label: 'Resident Name' },
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'purokSitio', label: 'Purok/Sitio' },
  { key: 'contactNumber', label: 'Contact Number' },
  { key: 'beneficiaryStatus', label: 'Beneficiary Status' },
  { key: 'dateServed', label: 'Date Served' },
  { key: 'processedBy', label: 'Processed By' },
  { key: 'remarks', label: 'Remarks' }
];

const mapServiceExportRow = (service) => ({
  ...service,
  startDate: formatCsvDate(service.startDate),
  endDate: formatCsvDate(service.endDate),
  beneficiaryProgress: `${service.beneficiaryProgress || 0}%`
});

const mapResidentExportRow = (service, resident) => ({
  serviceName: service.name,
  serviceId: service.id,
  category: service.category,
  barangay: resident.barangay,
  residentCode: resident.residentCode,
  name: resident.name,
  age: resident.age,
  gender: resident.gender,
  purokSitio: resident.purokSitio,
  contactNumber: resident.contactNumber,
  beneficiaryStatus: resident.beneficiaryStatus,
  dateServed: formatCsvDate(resident.dateServed),
  processedBy: resident.processedBy,
  remarks: resident.remarks
});

export const getServiceDetails = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const summary = await getServiceSummary(service);
    return res.json({ data: { ...service, summary } });
  } catch (error) {
    return next(error);
  }
};

export const changeServiceStatus = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const { status } = req.body;
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid service status' });
    }

    await pool.execute('UPDATE services SET status = ? WHERE id = ?', [status, service.rawId]);
    const updated = await getServiceById(service.rawId);
    await logAudit({ user: req.user, action: 'services.status_update', entityType: 'services', entityId: service.rawId, details: { status } });
    emitRealtimeEvent('services:changed', { action: 'status-updated', data: updated });
    emitRealtimeEvent('dashboard:changed', { reason: 'service-status-updated' });
    return res.json({ data: updated });
  } catch (error) {
    return next(error);
  }
};

export const getServiceChecklist = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, req.query);
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
};

export const updateServiceBeneficiary = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const { residentId } = req.params;
    const { status, remarks = '' } = req.body;

    if (!allowedBeneficiaryStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid beneficiary status' });
    }

    const [residentRows] = await pool.execute('SELECT id, barangay FROM resident_accounts WHERE id = ?', [residentId]);
    if (residentRows.length === 0) return res.status(404).json({ message: 'Resident not found' });
    if (residentRows[0].barangay !== service.barangay) {
      return res.status(400).json({ message: 'Resident does not belong to this service barangay' });
    }

    await pool.execute(
      `INSERT INTO service_beneficiaries (service_id, resident_id, status, served_at, processed_by, processed_by_name, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), served_at = VALUES(served_at), processed_by = VALUES(processed_by), processed_by_name = VALUES(processed_by_name), remarks = VALUES(remarks)`,
      [
        service.rawId,
        residentId,
        status,
        status === 'Served' ? new Date() : null,
        req.user?.id || null,
        req.user?.name || req.user?.email || null,
        remarks
      ]
    );

    await logAudit({ user: req.user, action: 'services.beneficiary_update', entityType: 'service_beneficiaries', entityId: residentId, details: { serviceId: service.rawId, status, remarks } });
    emitRealtimeEvent('services:changed', { action: 'beneficiary-updated', serviceId: service.rawId, residentId });
    emitRealtimeEvent('dashboard:changed', { reason: 'service-beneficiary-updated' });

    const rows = await getServiceChecklistRows(service, {});
    return res.json({ data: rows.find((row) => String(row.residentId) === String(residentId)) });
  } catch (error) {
    return next(error);
  }
};

export const resetServiceBeneficiary = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    await pool.execute('DELETE FROM service_beneficiaries WHERE service_id = ? AND resident_id = ?', [service.rawId, req.params.residentId]);
    await logAudit({ user: req.user, action: 'services.beneficiary_reset', entityType: 'service_beneficiaries', entityId: req.params.residentId, details: { serviceId: service.rawId } });
    emitRealtimeEvent('services:changed', { action: 'beneficiary-reset', serviceId: service.rawId, residentId: req.params.residentId });
    emitRealtimeEvent('dashboard:changed', { reason: 'service-beneficiary-reset' });
    return res.json({ data: { residentId: Number(req.params.residentId), beneficiaryStatus: 'Not Served' } });
  } catch (error) {
    return next(error);
  }
};

export const getServedBeneficiaries = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, { status: 'Served', ...req.query });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
};

export const getNotYetServedResidents = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, req.query);
    return res.json({ data: rows.filter((row) => row.beneficiaryStatus !== 'Served') });
  } catch (error) {
    return next(error);
  }
};

export const getServiceSummaryStats = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const summary = await getServiceSummary(service);
    return res.json({ data: summary });
  } catch (error) {
    return next(error);
  }
};

export const exportServicesSummaryCsv = async (req, res, next) => {
  try {
    const services = await getScopedServices(req);
    await logAudit({ user: req.user, action: 'services.export_summary', entityType: 'services', details: req.query });
    return sendCsv(
      res,
      `community-services-summary-${todayStamp()}.csv`,
      serviceSummaryColumns,
      services.map(mapServiceExportRow)
    );
  } catch (error) {
    return next(error);
  }
};

export const exportServiceChecklistCsv = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, req.query);
    await logAudit({ user: req.user, action: 'services.export_checklist', entityType: 'services', entityId: service.rawId, details: req.query });
    return sendCsv(
      res,
      `community-${slugify(service.name)}-checklist-${todayStamp()}.csv`,
      serviceResidentColumns,
      rows.map((row) => mapResidentExportRow(service, row))
    );
  } catch (error) {
    return next(error);
  }
};

export const exportServiceBeneficiariesCsv = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, { ...req.query, status: 'Served' });
    await logAudit({ user: req.user, action: 'services.export_beneficiaries', entityType: 'services', entityId: service.rawId, details: req.query });
    return sendCsv(
      res,
      `community-${slugify(service.name)}-beneficiaries-${todayStamp()}.csv`,
      serviceResidentColumns,
      rows.map((row) => mapResidentExportRow(service, row))
    );
  } catch (error) {
    return next(error);
  }
};

export const exportServiceNotYetServedCsv = async (req, res, next) => {
  try {
    const service = await getServiceForAction(req, req.params.id);
    const rows = await getServiceChecklistRows(service, req.query);
    const notYetServed = rows.filter((row) => row.beneficiaryStatus !== 'Served');
    await logAudit({ user: req.user, action: 'services.export_not_yet_served', entityType: 'services', entityId: service.rawId, details: req.query });
    return sendCsv(
      res,
      `community-${slugify(service.name)}-not-yet-served-${todayStamp()}.csv`,
      serviceResidentColumns,
      notYetServed.map((row) => mapResidentExportRow(service, row))
    );
  } catch (error) {
    return next(error);
  }
};
