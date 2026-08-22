import { pool } from "../config/db.js";
import { PERMISSIONS, ROLES } from "../rbac/roles.js";
import { formatResidentName } from "../utils/residentName.js";

// Builds filtered tabular reports for residents and other operational modules.

const numberFormat = new Intl.NumberFormat("en-US");
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const reportTitles = {
  residents: "Resident Report",
  requests: "Document Request Report",
  services: "Service Report",
  beneficiaries: "Service Beneficiary Report",
  barangays: "Barangay Performance Report",
  staff: "Staff Report",
  offices: "Office Report",
};

const roleLabels = {
  admin: "Admin",
  barangay_staff: "Barangay Staff",
  resident: "Resident",
};

const padId = (prefix, id, width = 4) =>
  `${prefix}-${String(id).padStart(width, "0")}`;

const isValidDate = (value) => Boolean(value) && datePattern.test(String(value));

const parseDateFilter = (value) => (isValidDate(value) ? value : "");

const formatCount = (value) => numberFormat.format(Number(value || 0));

const isBarangayStaff = (user) => user?.role === ROLES.BARANGAY_STAFF;

const canViewAllResidentBarangays = (user) =>
  !isBarangayStaff(user) ||
  user.permissions?.includes(PERMISSIONS.RESIDENTS_VIEW_ALL);

const canViewAllServiceBarangays = (user) =>
  !isBarangayStaff(user) ||
  user.permissions?.includes(PERMISSIONS.SERVICES_VIEW_ALL_BARANGAYS);

const canViewAllServiceOffices = (user) =>
  !isBarangayStaff(user) ||
  user.permissions?.includes(PERMISSIONS.SERVICES_VIEW_ALL_OFFICES) ||
  user.permissions?.includes(PERMISSIONS.SERVICES_VIEW_ALL_BARANGAYS);

const resolveBarangay = (user, requested, canViewAll) => {
  if (!canViewAll) return user?.barangay || "";
  return String(requested || "").trim();
};

const pushDateRange = (filters, values, column, from, to) => {
  if (from) {
    filters.push(`DATE(${column}) >= ?`);
    values.push(from);
  }
  if (to) {
    filters.push(`DATE(${column}) <= ?`);
    values.push(to);
  }
};

const dateClause = (column, from, to, values) => {
  const parts = [];
  if (from) {
    parts.push(`DATE(${column}) >= ?`);
    values.push(from);
  }
  if (to) {
    parts.push(`DATE(${column}) <= ?`);
    values.push(to);
  }
  return parts.join(" AND ");
};

const pushEquals = (filters, values, column, value) => {
  if (!value) return;
  filters.push(`${column} = ?`);
  values.push(value);
};

// Keeps services that were active in the range; missing start/end dates stay included.
const pushServiceActivePeriod = (filters, values, from, to) => {
  if (from) {
    filters.push("(services.end_date IS NULL OR services.end_date >= ?)");
    values.push(from);
  }
  if (to) {
    filters.push("(services.start_date IS NULL OR services.start_date <= ?)");
    values.push(to);
  }
};

const percent = (part, total) =>
  total > 0 ? Math.round((part / total) * 100) : 0;

const remainingCount = (target, served) =>
  Math.max(Number(target || 0) - Number(served || 0), 0);

const applyServiceScope = (user, filters, values) => {
  if (!isBarangayStaff(user)) return;

  if (!canViewAllServiceBarangays(user)) {
    filters.push("services.barangay = ?");
    values.push(user.barangay || "");
  }

  if (!canViewAllServiceOffices(user)) {
    filters.push("(services.office_id = ? OR services.office_id IS NULL)");
    values.push(user.officeId || 0);
  }
};

const serviceSelect = `
  SELECT services.id, services.name, services.category, services.barangay,
    offices.name AS office_name, services.target_beneficiaries,
    COALESCE(served.served_count, 0) AS served_count,
    COALESCE(targets.target_residents, 0) AS target_residents,
    services.status, services.created_at
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

const mapServiceRow = (row) => {
  const target = Number(row.target_residents || row.target_beneficiaries || 0);
  const served = Number(row.served_count || 0);
  const remaining = remainingCount(target, served);

  return {
    id: padId("SRV", row.id, 3),
    rawId: row.id,
    name: row.name,
    category: row.category,
    barangay: row.barangay,
    officeName: row.office_name || "",
    target: target,
    served,
    remaining,
    progress: `${percent(served, target)}%`,
    status: row.status,
    createdAt: row.created_at,
  };
};

const getResidentsReport = async ({ user, from, to, barangay, verificationStatus, accountStatus }) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllResidentBarangays(user),
  );

  pushEquals(filters, values, "barangay", scopedBarangay);
  pushEquals(filters, values, "verification_status", verificationStatus);
  pushEquals(filters, values, "account_status", accountStatus);
  pushDateRange(filters, values, "created_at", from, to);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT id, first_name, middle_name, last_name, barangay, purok_sitio, gender, age,
            verification_status, account_status, created_at
     FROM resident_accounts
     ${where}
     ORDER BY last_name ASC, first_name ASC`,
    values,
  );

  const mapped = rows.map((row) => ({
    id: padId("RES", row.id),
    name: formatResidentName(row.first_name, row.middle_name, row.last_name),
    barangay: row.barangay,
    purokSitio: row.purok_sitio || "",
    gender: row.gender || "Unspecified",
    age: row.age || "",
    verificationStatus: row.verification_status,
    accountStatus: row.account_status,
    createdAt: row.created_at,
  }));

  const verified = mapped.filter((row) => row.verificationStatus === "Verified").length;
  const pending = mapped.filter((row) => row.verificationStatus === "Pending").length;
  const rejected = mapped.filter((row) => row.verificationStatus === "Rejected").length;

  return {
    columns: [
      { key: "id", label: "Resident ID" },
      { key: "name", label: "Name" },
      { key: "barangay", label: "Barangay" },
      { key: "purokSitio", label: "Purok/Sitio" },
      { key: "gender", label: "Gender" },
      { key: "age", label: "Age" },
      { key: "verificationStatus", label: "Verification" },
      { key: "accountStatus", label: "Account" },
      { key: "createdAt", label: "Registered" },
    ],
    rows: mapped,
    summary: [
      { label: "Total residents", value: formatCount(mapped.length) },
      { label: "Verified", value: formatCount(verified) },
      { label: "Pending", value: formatCount(pending) },
      { label: "Rejected", value: formatCount(rejected) },
    ],
  };
};

const getRequestsReport = async ({
  user,
  from,
  to,
  barangay,
  status,
  documentTypeId,
}) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllResidentBarangays(user),
  );

  if (isBarangayStaff(user) || scopedBarangay) {
    filters.push("ra.barangay = ?");
    values.push(scopedBarangay || user.barangay || "");
  }

  pushEquals(filters, values, "sr.status", status);
  const documentType = Number(documentTypeId);
  if (Number.isInteger(documentType) && documentType > 0) {
    filters.push("sr.document_type_id = ?");
    values.push(documentType);
  }
  pushDateRange(filters, values, "sr.created_at", from, to);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT sr.id, sr.status, sr.created_at,
            TRIM(CONCAT_WS(' ', ra.first_name, NULLIF(TRIM(ra.middle_name), ''), ra.last_name)) AS resident_name,
            ra.barangay AS barangay, dt.name AS document_type_name
     FROM service_requests sr
     LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
     LEFT JOIN document_types dt ON dt.id = sr.document_type_id
     ${where}
     ORDER BY sr.created_at DESC`,
    values,
  );

  const mapped = rows.map((row) => ({
    id: padId("REQ", row.id),
    residentName: row.resident_name || "Resident",
    barangay: row.barangay || "",
    documentTypeName: row.document_type_name || "Document",
    status: row.status === "Completed" ? "Ready to Claim" : row.status,
    createdAt: row.created_at,
  }));

  const open = rows.filter((row) =>
    ["Submitted", "Under Review", "Approved", "Processing"].includes(row.status),
  ).length;
  const completed = rows.filter((row) =>
    ["Completed", "Claimed"].includes(row.status),
  ).length;

  return {
    columns: [
      { key: "id", label: "Request ID" },
      { key: "residentName", label: "Resident" },
      { key: "barangay", label: "Barangay" },
      { key: "documentTypeName", label: "Document Type" },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Submitted" },
    ],
    rows: mapped,
    summary: [
      { label: "Total requests", value: formatCount(mapped.length) },
      { label: "Open", value: formatCount(open) },
      { label: "Completed / claimed", value: formatCount(completed) },
    ],
  };
};

const getServicesReport = async ({ user, from, to, barangay, category, status }) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllServiceBarangays(user),
  );

  applyServiceScope(user, filters, values);
  if (scopedBarangay && canViewAllServiceBarangays(user)) {
    pushEquals(filters, values, "services.barangay", scopedBarangay);
  }
  pushEquals(filters, values, "services.category", category);
  pushEquals(filters, values, "services.status", status);
  pushServiceActivePeriod(filters, values, from, to);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `${serviceSelect}
     ${where}
     ORDER BY services.name ASC`,
    values,
  );

  const mapped = rows.map(mapServiceRow);
  const served = mapped.reduce((sum, row) => sum + Number(row.served || 0), 0);
  const remaining = mapped.reduce((sum, row) => sum + Number(row.remaining || 0), 0);

  return {
    columns: [
      { key: "id", label: "Service ID" },
      { key: "name", label: "Service" },
      { key: "category", label: "Category" },
      { key: "barangay", label: "Barangay" },
      { key: "officeName", label: "Office" },
      { key: "target", label: "Target" },
      { key: "served", label: "Served" },
      { key: "remaining", label: "Not yet served" },
      { key: "progress", label: "Progress" },
      { key: "status", label: "Status" },
    ],
    rows: mapped,
    summary: [
      { label: "Services", value: formatCount(mapped.length) },
      { label: "Served", value: formatCount(served) },
      { label: "Not yet served", value: formatCount(remaining) },
    ],
  };
};

const getBeneficiariesReport = async ({
  user,
  from,
  to,
  barangay,
  serviceId,
  beneficiaryStatus,
}) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllServiceBarangays(user),
  );

  applyServiceScope(user, filters, values);
  if (scopedBarangay && canViewAllServiceBarangays(user)) {
    pushEquals(filters, values, "services.barangay", scopedBarangay);
  }
  const selectedServiceId = Number(serviceId);
  if (Number.isInteger(selectedServiceId) && selectedServiceId > 0) {
    filters.push("services.id = ?");
    values.push(selectedServiceId);
  }

  filters.push("(services.target_scope != 'Senior Citizens' OR ra.age >= 60)");

  if (beneficiaryStatus === "Not Served") {
    filters.push("sb.id IS NULL");
  } else if (beneficiaryStatus) {
    filters.push("sb.status = ?");
    values.push(beneficiaryStatus);
  }

  if (from || to) {
    if (beneficiaryStatus === "Served") {
      pushDateRange(filters, values, "sb.served_at", from, to);
    } else if (beneficiaryStatus && beneficiaryStatus !== "Not Served") {
      pushDateRange(filters, values, "sb.created_at", from, to);
    } else if (!beneficiaryStatus) {
      const servedValues = [];
      const otherValues = [];
      const served = dateClause("sb.served_at", from, to, servedValues);
      const other = dateClause("sb.created_at", from, to, otherValues);
      filters.push(`(
        (sb.status = 'Served' AND ${served})
        OR (sb.id IS NOT NULL AND sb.status <> 'Served' AND ${other})
        OR sb.id IS NULL
      )`);
      values.push(...servedValues, ...otherValues);
    }
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT services.id AS service_id, services.name AS service_name,
            ra.id AS resident_id, ra.first_name, ra.middle_name, ra.last_name,
            ra.barangay, ra.purok_sitio,
            COALESCE(sb.status, 'Not Served') AS beneficiary_status,
            sb.served_at
     FROM services
     INNER JOIN resident_accounts ra ON ra.barangay = services.barangay
     LEFT JOIN service_beneficiaries sb
       ON sb.service_id = services.id AND sb.resident_id = ra.id
     ${where}
     ORDER BY services.name ASC, ra.last_name ASC, ra.first_name ASC`,
    values,
  );

  const mapped = rows.map((row) => ({
    id: `${row.service_id}-${row.resident_id}`,
    serviceName: row.service_name,
    residentName: formatResidentName(
      row.first_name,
      row.middle_name,
      row.last_name,
    ),
    barangay: row.barangay,
    purokSitio: row.purok_sitio || "",
    beneficiaryStatus: row.beneficiary_status,
    dateServed: row.served_at,
  }));

  const served = mapped.filter((row) => row.beneficiaryStatus === "Served").length;
  const notServed = mapped.filter((row) => row.beneficiaryStatus === "Not Served").length;
  const pending = mapped.filter((row) => row.beneficiaryStatus === "Pending").length;

  return {
    columns: [
      { key: "serviceName", label: "Service" },
      { key: "residentName", label: "Resident" },
      { key: "barangay", label: "Barangay" },
      { key: "purokSitio", label: "Purok/Sitio" },
      { key: "beneficiaryStatus", label: "Status" },
      { key: "dateServed", label: "Date served" },
    ],
    rows: mapped,
    summary: [
      { label: "Records", value: formatCount(mapped.length) },
      { label: "Served", value: formatCount(served) },
      { label: "Not yet served", value: formatCount(notServed) },
      { label: "Pending", value: formatCount(pending) },
    ],
  };
};

const getBarangaysReport = async ({ user, from, to, barangay }) => {
  const residentFilters = [];
  const residentValues = [];
  const requestFilters = [];
  const requestValues = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllResidentBarangays(user),
  );

  pushEquals(residentFilters, residentValues, "barangay", scopedBarangay);
  pushDateRange(residentFilters, residentValues, "created_at", from, to);
  if (scopedBarangay) {
    requestFilters.push("ra.barangay = ?");
    requestValues.push(scopedBarangay);
  }
  pushDateRange(requestFilters, requestValues, "sr.created_at", from, to);

  const residentWhere = residentFilters.length
    ? `WHERE ${residentFilters.join(" AND ")}`
    : "";
  const requestWhere = requestFilters.length
    ? `WHERE ${requestFilters.join(" AND ")}`
    : "";
  const barangayWhere = scopedBarangay ? "WHERE name = ?" : "";
  const barangayValues = scopedBarangay ? [scopedBarangay] : [];

  const [barangayRows] = await pool.execute(
    `SELECT name FROM barangays ${barangayWhere} ORDER BY name ASC`,
    barangayValues,
  );
  const [residentRows] = await pool.execute(
    `SELECT barangay, COUNT(*) AS residents,
            SUM(verification_status = 'Verified') AS verified
     FROM resident_accounts
     ${residentWhere}
     GROUP BY barangay`,
    residentValues,
  );
  const [requestRows] = await pool.execute(
    `SELECT ra.barangay AS barangay, COUNT(*) AS total_requests,
            SUM(sr.status IN ('Completed', 'Claimed')) AS completed_requests
     FROM service_requests sr
     LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
     ${requestWhere}
     GROUP BY ra.barangay`,
    requestValues,
  );

  const residentMap = Object.fromEntries(
    residentRows.map((row) => [row.barangay, row]),
  );
  const requestMap = Object.fromEntries(
    requestRows.map((row) => [row.barangay, row]),
  );

  const mapped = barangayRows.map((row) => {
    const residents = Number(residentMap[row.name]?.residents || 0);
    const verified = Number(residentMap[row.name]?.verified || 0);
    const submitted = Number(requestMap[row.name]?.total_requests || 0);
    const completed = Number(requestMap[row.name]?.completed_requests || 0);

    return {
      id: row.name,
      barangay: row.name,
      residents,
      verified,
      verificationPercent: `${percent(verified, residents)}%`,
      requestsSubmitted: submitted,
      requestsCompleted: completed,
    };
  });

  const totalResidents = mapped.reduce((sum, row) => sum + row.residents, 0);
  const totalVerified = mapped.reduce((sum, row) => sum + row.verified, 0);

  return {
    columns: [
      { key: "barangay", label: "Barangay" },
      { key: "residents", label: "Residents" },
      { key: "verified", label: "Verified" },
      { key: "verificationPercent", label: "Verification" },
      { key: "requestsSubmitted", label: "Requests" },
      { key: "requestsCompleted", label: "Completed requests" },
    ],
    rows: mapped,
    summary: [
      { label: "Barangays", value: formatCount(mapped.length) },
      { label: "Residents", value: formatCount(totalResidents) },
      { label: "Verified", value: formatCount(totalVerified) },
      {
        label: "Verification coverage",
        value: `${percent(totalVerified, totalResidents)}%`,
      },
    ],
  };
};

const getStaffReport = async ({ user, from, to, barangay, role, status }) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllResidentBarangays(user),
  );

  pushEquals(filters, values, "sa.barangay", scopedBarangay);
  pushEquals(filters, values, "sa.role", role);
  pushEquals(filters, values, "sa.status", status);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT sa.id, sa.name, sa.email, sa.role, sa.barangay, o.name AS office_name,
            sa.status, sa.created_at
     FROM staff_accounts sa
     LEFT JOIN offices o ON o.id = sa.office_id
     ${where}
     ORDER BY sa.name ASC`,
    values,
  );

  const mapped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: roleLabels[row.role] || row.role,
    barangay: row.barangay || "",
    officeName: row.office_name || "",
    status: row.status,
    createdAt: row.created_at,
  }));

  const active = mapped.filter((row) => row.status === "Active").length;
  const admins = rows.filter((row) => row.role === "admin").length;

  return {
    columns: [
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "role", label: "Role" },
      { key: "barangay", label: "Barangay" },
      { key: "officeName", label: "Office" },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Created" },
    ],
    rows: mapped,
    summary: [
      { label: "Staff", value: formatCount(mapped.length) },
      { label: "Active", value: formatCount(active) },
      { label: "Admins", value: formatCount(admins) },
    ],
  };
};

const getOfficesReport = async ({ user, from, to, barangay, status }) => {
  const filters = [];
  const values = [];
  const scopedBarangay = resolveBarangay(
    user,
    barangay,
    canViewAllResidentBarangays(user),
  );

  pushEquals(filters, values, "barangay", scopedBarangay);
  pushEquals(filters, values, "status", status);

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT id, name, barangay, description, status, created_at
     FROM offices
     ${where}
     ORDER BY barangay ASC, name ASC`,
    values,
  );

  const mapped = rows.map((row) => ({
    id: row.id,
    name: row.name,
    barangay: row.barangay,
    description: row.description || "",
    status: row.status,
    createdAt: row.created_at,
  }));

  const active = mapped.filter((row) => row.status === "Active").length;

  return {
    columns: [
      { key: "name", label: "Office" },
      { key: "barangay", label: "Barangay" },
      { key: "description", label: "Description" },
      { key: "status", label: "Status" },
      { key: "createdAt", label: "Created" },
    ],
    rows: mapped,
    summary: [
      { label: "Offices", value: formatCount(mapped.length) },
      { label: "Active", value: formatCount(active) },
    ],
  };
};

const builders = {
  residents: getResidentsReport,
  requests: getRequestsReport,
  services: getServicesReport,
  beneficiaries: getBeneficiariesReport,
  barangays: getBarangaysReport,
  staff: getStaffReport,
  offices: getOfficesReport,
};

const readFilters = (query) => ({
  from: parseDateFilter(query.from),
  to: parseDateFilter(query.to),
  barangay: String(query.barangay || "").trim(),
  verificationStatus: String(query.verificationStatus || "").trim(),
  accountStatus: String(query.accountStatus || "").trim(),
  status: String(query.status || "").trim(),
  documentTypeId: String(query.documentTypeId || "").trim(),
  category: String(query.category || "").trim(),
  serviceId: String(query.serviceId || "").trim(),
  beneficiaryStatus: String(query.beneficiaryStatus || "").trim(),
  role: String(query.role || "").trim(),
});

export const getReport = async (req, res, next) => {
  try {
    const type = String(req.params.type || "").trim();
    const builder = builders[type];

    if (!builder) {
      return res.status(400).json({ message: "Unknown report type" });
    }

    const filters = readFilters(req.query);
    const report = await builder({ user: req.user, ...filters });

    return res.json({
      data: {
        type,
        title: reportTitles[type],
        generatedAt: new Date().toISOString(),
        filters,
        summary: report.summary,
        columns: report.columns,
        rows: report.rows,
      },
    });
  } catch (error) {
    return next(error);
  }
};
