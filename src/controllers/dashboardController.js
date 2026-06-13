import { pool } from '../config/db.js';
import { PERMISSIONS, ROLES } from '../rbac/roles.js';

const numberFormat = new Intl.NumberFormat('en-US');
const canViewAllResidents = (user) =>
  user?.role !== ROLES.BARANGAY_STAFF || user.permissions?.includes(PERMISSIONS.RESIDENTS_VIEW_ALL);

export const getDashboard = async (req, res, next) => {
  try {
    if (req.user?.role === ROLES.RESIDENT) {
      const [[serviceCounts]] = await pool.query(
        `SELECT
          COUNT(*) AS totalServices,
          SUM(status = 'Active') AS activeServices
         FROM services`
      );
      const [[resident]] = await pool.execute(
        `SELECT barangay, verification_status AS verificationStatus, account_status AS accountStatus, status
         FROM resident_accounts
         WHERE id = ?`,
        [req.user.id]
      );
      const [serviceRows] = await pool.query(
        `SELECT category, COUNT(*) AS total
         FROM services
         WHERE status = 'Active'
         GROUP BY category
         ORDER BY total DESC`
      );
      const [[requestCounts]] = await pool.execute(
        `SELECT
          COUNT(*) AS totalRequests,
          SUM(status IN ('Submitted', 'Under Review', 'Approved', 'Processing')) AS openRequests
         FROM service_requests
         WHERE resident_id = ?`,
        [req.user.id]
      );
      const [recentRequests] = await pool.execute(
        `SELECT sr.title, sr.status, sr.created_at, dt.name AS documentTypeName
         FROM service_requests sr
         LEFT JOIN document_types dt ON dt.id = sr.document_type_id
         WHERE sr.resident_id = ?
         ORDER BY sr.created_at DESC
         LIMIT 5`,
        [req.user.id]
      );

      return res.json({
        data: {
          dashboardMetrics: [
            { label: 'Available Services', value: numberFormat.format(Number(serviceCounts.activeServices || 0)), trend: 'Community programs', tone: 'success' },
            { label: 'My Requests', value: numberFormat.format(Number(requestCounts.totalRequests || 0)), trend: `${numberFormat.format(Number(requestCounts.openRequests || 0))} active`, tone: 'info' },
            { label: 'Pending Updates', value: numberFormat.format(Number(requestCounts.openRequests || 0) + (resident?.verificationStatus === 'Pending' ? 1 : 0)), trend: resident?.verificationStatus || 'Pending', tone: resident?.verificationStatus === 'Pending' ? 'warning' : 'success' },
            { label: 'Barangay', value: resident?.barangay || req.user.barangay || 'Assigned', trend: 'Resident profile', tone: 'primary' },
            { label: 'Total Services', value: numberFormat.format(Number(serviceCounts.totalServices || 0)), trend: 'System catalog', tone: 'info' }
          ],
          pendingRequests: recentRequests.map((request) => ({
            title: request.title,
            meta: `${request.documentTypeName || 'Document'} request`,
            status: request.status
          })),
          serviceUtilization: serviceRows.map((row) => ({
            label: row.category,
            value: `${Math.max(10, Number(row.total) * 20)}%`
          })),
          barangayPerformance: [
            { label: resident?.barangay || req.user.barangay || 'Your Barangay', value: resident?.verificationStatus || 'Pending', status: resident?.verificationStatus || 'Pending' }
          ],
          recentActivity: [
            { title: 'Resident dashboard ready', description: 'Track requests and account updates here.', time: 'Today' }
          ],
          residentSummary: [
            { label: 'Verification', value: resident?.verificationStatus || 'Pending' },
            { label: 'Account Access', value: resident?.accountStatus || 'Inactive' },
            { label: 'Barangay', value: resident?.barangay || req.user.barangay || 'Assigned' },
            { label: 'Open Requests', value: numberFormat.format(Number(requestCounts.openRequests || 0)) }
          ]
        }
      });
    }

    const scopedToBarangay = !canViewAllResidents(req.user);
    const residentWhere = scopedToBarangay ? 'WHERE barangay = ?' : '';
    const residentValues = scopedToBarangay ? [req.user.barangay || ''] : [];
    const requestWhere = scopedToBarangay ? 'WHERE ra.barangay = ?' : '';
    const requestStatusWhere = scopedToBarangay
      ? `WHERE ra.barangay = ? AND sr.status IN ('Submitted', 'Under Review', 'Approved', 'Processing')`
      : `WHERE sr.status IN ('Submitted', 'Under Review', 'Approved', 'Processing')`;

    const [[residentCounts]] = await pool.execute(
      `SELECT
        COUNT(*) AS totalResidents,
        SUM(verification_status = 'Pending') AS pendingResidents,
        SUM(verification_status = 'Verified') AS verifiedResidents,
        SUM(account_status = 'Active') AS activeResidents,
        COUNT(DISTINCT barangay) AS barangays
       FROM resident_accounts
       ${residentWhere}`,
      residentValues
    );
    const [[serviceCounts]] = await pool.query(
      `SELECT
        COUNT(*) AS totalServices,
        SUM(status = 'Active') AS activeServices,
        COALESCE(SUM(beneficiaries), 0) AS totalBeneficiaries,
        COALESCE(SUM(pending_requests), 0) AS pendingRequests
       FROM services`
    );
    const [recentResidents] = await pool.execute(
      `SELECT first_name, last_name, barangay, status, created_at
       FROM resident_accounts
       ${residentWhere}
       ORDER BY created_at DESC
       LIMIT 5`,
      residentValues
    );
    const [pendingResidents] = await pool.execute(
      `SELECT first_name, last_name, barangay, status, created_at
       FROM resident_accounts
       WHERE verification_status = 'Pending'${scopedToBarangay ? ' AND barangay = ?' : ''}
       ORDER BY created_at DESC
       LIMIT 5`,
      residentValues
    );
    const [[requestCounts]] = await pool.execute(
      `SELECT
        COUNT(*) AS totalRequests,
        SUM(sr.status IN ('Submitted', 'Under Review', 'Approved', 'Processing')) AS openRequests,
        SUM(sr.status = 'Submitted') AS submittedRequests
       FROM service_requests sr
       LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
       ${requestWhere}`,
      residentValues
    );
    const [pendingServiceRequests] = await pool.execute(
      `SELECT sr.title, sr.status, sr.created_at, CONCAT(ra.first_name, ' ', ra.last_name) AS residentName,
        ra.barangay, dt.name AS documentTypeName
       FROM service_requests sr
       LEFT JOIN resident_accounts ra ON ra.id = sr.resident_id
       LEFT JOIN document_types dt ON dt.id = sr.document_type_id
       ${requestStatusWhere}
       ORDER BY sr.created_at DESC
       LIMIT 5`,
      residentValues
    );
    const [serviceUtilizationRows] = await pool.query(
      `SELECT category, COALESCE(SUM(beneficiaries), 0) AS beneficiaries
       FROM services
       GROUP BY category
       ORDER BY beneficiaries DESC
       LIMIT 5`
    );
    const [barangayRows] = await pool.execute(
      `SELECT barangay, COUNT(*) AS residents, SUM(verification_status = 'Verified') AS verified
       FROM resident_accounts
       ${residentWhere}
       GROUP BY barangay
       ORDER BY residents DESC
       LIMIT 5`,
      residentValues
    );

    const totalResidents = Number(residentCounts.totalResidents || 0);
    const totalServices = Number(serviceCounts.totalServices || 0);
    const activeServices = Number(serviceCounts.activeServices || 0);
    const pendingRequests = Number(requestCounts.openRequests || 0) + Number(residentCounts.pendingResidents || 0);
    const barangays = Number(residentCounts.barangays || 0);

    const dashboardMetrics = [
      { label: 'Residents', value: numberFormat.format(totalResidents), trend: `${numberFormat.format(Number(residentCounts.verifiedResidents || 0))} verified`, tone: 'info' },
      { label: 'Services', value: numberFormat.format(totalServices), trend: `${numberFormat.format(activeServices)} active`, tone: 'success' },
      { label: 'Pending Requests', value: numberFormat.format(pendingRequests), trend: 'Needs review', tone: 'warning' },
      { label: 'Barangays', value: numberFormat.format(barangays), trend: 'With registered residents', tone: 'primary' },
      { label: 'Areas', value: numberFormat.format(Math.max(barangays, 1)), trend: 'Coverage zones', tone: 'info' }
    ];

    const maxBeneficiaries = Math.max(...serviceUtilizationRows.map((row) => Number(row.beneficiaries)), 1);
    const serviceUtilization = serviceUtilizationRows.map((row) => ({
      label: row.category,
      value: `${Math.round((Number(row.beneficiaries) / maxBeneficiaries) * 100)}%`
    }));

    const barangayPerformance = barangayRows.map((row) => {
      const residents = Number(row.residents || 0);
      const verified = Number(row.verified || 0);
      const percent = residents > 0 ? Math.round((verified / residents) * 100) : 0;
      return {
        label: row.barangay,
        value: `${percent}%`,
        status: percent >= 80 ? 'Verified' : percent >= 50 ? 'Active' : 'Pending'
      };
    });

    const recentActivity = recentResidents.map((resident) => ({
      title: 'Resident registration updated',
      description: `${resident.first_name} ${resident.last_name} - ${resident.barangay}`,
      time: new Date(resident.created_at).toLocaleDateString()
    }));

    const pendingRequestsList = [
      ...pendingServiceRequests.map((request) => ({
        title: request.title,
        meta: `${request.residentName || 'Resident'} - ${request.documentTypeName || 'Document'}`,
        status: request.status
      })),
      ...pendingResidents.map((resident) => ({
      title: `${resident.first_name} ${resident.last_name} identity review`,
      meta: `${resident.barangay} - pending resident verification`,
      status: resident.status
      }))
    ].slice(0, 5);

    const residentSummary = [
      { label: 'New Registrations', value: numberFormat.format(totalResidents) },
      { label: 'Profiles Verified', value: numberFormat.format(Number(residentCounts.verifiedResidents || 0)) },
      { label: 'Active Accounts', value: numberFormat.format(Number(residentCounts.activeResidents || 0)) },
      { label: 'Pending Review', value: numberFormat.format(Number(residentCounts.pendingResidents || 0)) },
    ];

    return res.json({
      data: {
        dashboardMetrics,
        pendingRequests: pendingRequestsList,
        serviceUtilization,
        barangayPerformance,
        recentActivity,
        residentSummary
      }
    });
  } catch (error) {
    return next(error);
  }
};
