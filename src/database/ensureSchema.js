// This file keeps the MySQL schema up to date when the server starts.
// It creates missing tables, adds new columns safely, and seeds default reference data.

// Returns true when a column already exists on a table in the current database.
const columnExists = async (connection, tableName, columnName) => {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return Number(rows[0]?.count || 0) > 0;
};

// Adds a column only if it is missing, so restarts stay idempotent.
const addColumnIfMissing = async (
  connection,
  tableName,
  columnName,
  definition,
) => {
  if (await columnExists(connection, tableName, columnName)) return;
  await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
};

// Ensures OTP, resident, and staff account tables (and related migrations) exist.
export const ensureResidentSchema = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS registration_otps (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(180) NOT NULL,
      otp_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      verified_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_registration_otp_email (email)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(180) NOT NULL,
      otp_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_password_reset_otp_email (email)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS resident_accounts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(180) NOT NULL,
      barangay VARCHAR(120) NOT NULL,
      birth_date DATE NULL,
      age INT UNSIGNED NULL,
      gender ENUM('Female', 'Male', 'Unspecified') NOT NULL DEFAULT 'Unspecified',
      password_hash VARCHAR(255) NOT NULL,
      selfie_id_image VARCHAR(255) NOT NULL,
      role ENUM('resident') NOT NULL DEFAULT 'resident',
      verification_status ENUM('Pending', 'Needs Correction', 'Verified', 'Rejected') NOT NULL DEFAULT 'Pending',
      account_status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Inactive',
      status ENUM('Pending', 'Needs Correction', 'Verified', 'Active', 'Inactive', 'Rejected') NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_resident_email (email)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS staff_accounts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      email VARCHAR(180) NOT NULL,
      barangay VARCHAR(120) NULL,
      office_id INT UNSIGNED NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin', 'barangay_staff') NOT NULL,
      permissions JSON NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_staff_email (email)
    )
  `);
  await connection.query(`
    ALTER TABLE staff_accounts
    MODIFY role ENUM('admin', 'barangay_staff', 'super_admin', 'municipal_admin') NOT NULL
  `);
  await connection.query(`
    UPDATE staff_accounts
    SET role = 'admin'
    WHERE role IN ('super_admin', 'municipal_admin')
  `);
  await connection.query(`
    ALTER TABLE staff_accounts
    MODIFY role ENUM('admin', 'barangay_staff') NOT NULL
  `);
  await addColumnIfMissing(
    connection,
    "staff_accounts",
    "office_id",
    "office_id INT UNSIGNED NULL AFTER barangay",
  );
  await addColumnIfMissing(
    connection,
    "staff_accounts",
    "permissions",
    "permissions JSON NULL AFTER role",
  );
  await addColumnIfMissing(
    connection,
    "resident_accounts",
    "birth_date",
    "birth_date DATE NULL AFTER barangay",
  );
  await addColumnIfMissing(
    connection,
    "resident_accounts",
    "verification_status",
    "verification_status ENUM('Pending', 'Needs Correction', 'Verified', 'Rejected') NOT NULL DEFAULT 'Pending' AFTER role",
  );
  await addColumnIfMissing(
    connection,
    "resident_accounts",
    "account_status",
    "account_status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Inactive' AFTER verification_status",
  );
  await connection.query(`
    ALTER TABLE resident_accounts
    MODIFY selfie_id_image VARCHAR(255) NULL
  `);
  await connection.query(`
    ALTER TABLE resident_accounts
    MODIFY status ENUM('Pending', 'Needs Correction', 'Verified', 'Active', 'Inactive', 'Rejected') NOT NULL DEFAULT 'Pending'
  `);
  await connection.query(`
    UPDATE resident_accounts
    SET
      verification_status = CASE
        WHEN status IN ('Active', 'Verified', 'Inactive') THEN 'Verified'
        WHEN status = 'Needs Correction' THEN 'Needs Correction'
        WHEN status = 'Rejected' THEN 'Rejected'
        ELSE 'Pending'
      END,
      account_status = CASE
        WHEN status IN ('Active', 'Verified') THEN 'Active'
        ELSE 'Inactive'
      END
    WHERE verification_status = 'Pending'
      AND account_status = 'Inactive'
      AND status IN ('Active', 'Verified', 'Inactive', 'Needs Correction', 'Rejected')
  `);
};
// Ensures service categories, services, and beneficiary tracking tables exist.
export const ensureServiceSchema = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS service_categories (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      description TEXT NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_service_category_name (name)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS services (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      category VARCHAR(120) NOT NULL,
      barangay VARCHAR(120) NOT NULL DEFAULT 'All Barangays',
      office_id INT UNSIGNED NULL,
      visibility ENUM('own_barangay', 'all_barangays', 'public') NOT NULL DEFAULT 'own_barangay',
      description TEXT NULL,
      target_scope VARCHAR(120) NOT NULL DEFAULT 'All Residents',
      start_date DATE NULL,
      end_date DATE NULL,
      remarks TEXT NULL,
      target_beneficiaries INT UNSIGNED NOT NULL DEFAULT 0,
      beneficiaries INT UNSIGNED NOT NULL DEFAULT 0,
      pending_requests INT UNSIGNED NOT NULL DEFAULT 0,
      status ENUM('Active', 'Inactive', 'Completed') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await connection.query(`
    ALTER TABLE services
    MODIFY category VARCHAR(120) NOT NULL
  `);
  await connection.query(`
    UPDATE services
    SET status = CASE
      WHEN status IN ('Pending', 'Verified') THEN 'Active'
      ELSE status
    END
  `);
  await connection.query(`
    ALTER TABLE services
    MODIFY status ENUM('Active', 'Inactive', 'Completed') NOT NULL DEFAULT 'Active'
  `);
  await addColumnIfMissing(
    connection,
    "services",
    "office_id",
    "office_id INT UNSIGNED NULL AFTER barangay",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "description",
    "description TEXT NULL AFTER visibility",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "target_scope",
    "target_scope VARCHAR(120) NOT NULL DEFAULT 'All Residents' AFTER description",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "start_date",
    "start_date DATE NULL AFTER target_scope",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "end_date",
    "end_date DATE NULL AFTER start_date",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "remarks",
    "remarks TEXT NULL AFTER end_date",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "target_beneficiaries",
    "target_beneficiaries INT UNSIGNED NOT NULL DEFAULT 0 AFTER visibility",
  );
  await addColumnIfMissing(
    connection,
    "services",
    "visibility",
    "visibility ENUM('own_barangay', 'all_barangays', 'public') NOT NULL DEFAULT 'own_barangay' AFTER office_id",
  );
  await connection.query(`
    UPDATE services
    SET target_beneficiaries = GREATEST(target_beneficiaries, beneficiaries)
  `);
  await addColumnIfMissing(
    connection,
    "resident_accounts",
    "purok_sitio",
    "purok_sitio VARCHAR(120) NULL AFTER barangay",
  );
  await addColumnIfMissing(
    connection,
    "resident_accounts",
    "contact_number",
    "contact_number VARCHAR(80) NULL AFTER email",
  );
  await connection.query(`
    CREATE TABLE IF NOT EXISTS service_beneficiaries (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      service_id INT UNSIGNED NOT NULL,
      resident_id INT UNSIGNED NOT NULL,
      status ENUM('Pending', 'Served', 'Skipped', 'Not Eligible') NOT NULL DEFAULT 'Pending',
      served_at DATETIME NULL,
      processed_by INT UNSIGNED NULL,
      processed_by_name VARCHAR(160) NULL,
      remarks TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_service_resident (service_id, resident_id)
    )
  `);
};
// Ensures barangays, offices, requests, announcements, notifications, and settings tables exist.
export const ensurePhaseTwoSchema = async (connection) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS barangays (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      district VARCHAR(120) NOT NULL DEFAULT '',
      captain VARCHAR(160) NOT NULL DEFAULT '',
      contact VARCHAR(80) NOT NULL DEFAULT '',
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_barangay_name (name)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS offices (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      barangay VARCHAR(120) NOT NULL,
      description TEXT NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_office_barangay (name, barangay)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS service_requests (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      resident_id INT UNSIGNED NULL,
      service_id INT UNSIGNED NULL,
      document_type_id INT UNSIGNED NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT NULL,
      status ENUM('Submitted', 'Under Review', 'Approved', 'Rejected', 'Processing', 'Completed', 'Claimed', 'Cancelled') NOT NULL DEFAULT 'Submitted',
      priority ENUM('Low', 'Normal', 'High', 'Urgent') NOT NULL DEFAULT 'Normal',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await addColumnIfMissing(
    connection,
    "service_requests",
    "document_type_id",
    "document_type_id INT UNSIGNED NULL AFTER service_id",
  );
  await connection.query(`
    ALTER TABLE service_requests
    MODIFY status ENUM('Submitted', 'Under Review', 'Approved', 'Rejected', 'Processing', 'Completed', 'Claimed', 'Cancelled') NOT NULL DEFAULT 'Submitted'
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS document_types (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_document_type_name (name)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      title VARCHAR(180) NOT NULL,
      content TEXT NOT NULL,
      poster_image VARCHAR(500) NULL,
      audience ENUM('All', 'Residents', 'Barangay Staff', 'Admins') NOT NULL DEFAULT 'All',
      barangay VARCHAR(120) NULL,
      category ENUM('Advisory', 'Health', 'Education', 'Emergency', 'Event', 'Services') NOT NULL DEFAULT 'Advisory',
      priority ENUM('Normal', 'Important', 'Urgent') NOT NULL DEFAULT 'Normal',
      pinned TINYINT(1) NOT NULL DEFAULT 0,
      status ENUM('Draft', 'Published', 'Archived') NOT NULL DEFAULT 'Draft',
      published_at DATETIME NULL,
      expires_at DATETIME NULL,
      created_by INT UNSIGNED NULL,
      created_by_name VARCHAR(160) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await addColumnIfMissing(
    connection,
    "announcements",
    "poster_image",
    "poster_image VARCHAR(500) NULL AFTER content",
  );
  await connection.query(
    "ALTER TABLE announcements MODIFY poster_image VARCHAR(500) NULL",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "barangay",
    "barangay VARCHAR(120) NULL AFTER audience",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "category",
    "category ENUM('Advisory', 'Health', 'Education', 'Emergency', 'Event', 'Services') NOT NULL DEFAULT 'Advisory' AFTER barangay",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "priority",
    "priority ENUM('Normal', 'Important', 'Urgent') NOT NULL DEFAULT 'Normal' AFTER category",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "pinned",
    "pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER priority",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "expires_at",
    "expires_at DATETIME NULL AFTER published_at",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "created_by",
    "created_by INT UNSIGNED NULL AFTER expires_at",
  );
  await addColumnIfMissing(
    connection,
    "announcements",
    "created_by_name",
    "created_by_name VARCHAR(160) NULL AFTER created_by",
  );
  await connection.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NULL,
      user_role VARCHAR(60) NOT NULL,
      title VARCHAR(180) NOT NULL,
      message TEXT NOT NULL,
      read_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NULL,
      user_role VARCHAR(60) NOT NULL,
      action VARCHAR(120) NOT NULL,
      entity_type VARCHAR(120) NOT NULL,
      entity_id VARCHAR(80) NULL,
      details JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      setting_key VARCHAR(120) NOT NULL,
      setting_value TEXT NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_system_setting_key (setting_key)
    )
  `);
};
// Inserts starter barangays, categories, offices, announcements, and settings when tables are empty.
export const seedPhaseTwoDefaults = async (connection) => {
  await connection.query(`
    INSERT INTO barangays (name, district, captain, contact, status)
    SELECT * FROM (
      SELECT 'San Isidro', 'North District', 'Elena Ramos', '0917-100-0001', 'Active'
      UNION ALL SELECT 'Mabini', 'East District', 'Roberto Cruz', '0917-100-0002', 'Active'
      UNION ALL SELECT 'Poblacion', 'Central District', 'Ana Villamor', '0917-100-0003', 'Active'
      UNION ALL SELECT 'Bagong Silang', 'South District', 'Marco Reyes', '0917-100-0004', 'Active'
      UNION ALL SELECT 'Maligaya', 'West District', 'Teresa Lim', '0917-100-0005', 'Active'
    ) AS seed_barangays
    WHERE NOT EXISTS (SELECT 1 FROM barangays)
  `);
  await connection.query(`
    INSERT INTO service_categories (name, description, status)
    SELECT * FROM (
      SELECT 'Medical', 'Health-related assistance and clinical service coordination.', 'Active'
      UNION ALL SELECT 'Livelihood', 'Income, employment, and community livelihood support.', 'Active'
      UNION ALL SELECT 'Social Welfare', 'Financial, social, and emergency assistance programs.', 'Active'
      UNION ALL SELECT 'Education', 'Scholarship and learning support programs.', 'Active'
      UNION ALL SELECT 'Infrastructure', 'Community facilities and public works concerns.', 'Active'
    ) AS seed_service_categories
    WHERE NOT EXISTS (SELECT 1 FROM service_categories)
  `);
  await connection.query(`
    INSERT INTO offices (name, barangay, description, status)
    SELECT * FROM (
      SELECT 'Barangay Secretary Office', 'San Isidro', 'Handles certificates and resident records.', 'Active'
      UNION ALL SELECT 'Barangay Health Office', 'San Isidro', 'Handles health-related community services.', 'Active'
      UNION ALL SELECT 'Social Welfare Office', 'Mabini', 'Handles assistance and welfare services.', 'Active'
      UNION ALL SELECT 'Barangay Secretary Office', 'Poblacion', 'Handles certificates and resident records.', 'Active'
    ) AS seed_offices
    WHERE NOT EXISTS (SELECT 1 FROM offices)
  `);
  await connection.query(`
    INSERT INTO announcements (title, content, audience, status, published_at)
    SELECT * FROM (
      SELECT 'Community Health Schedule', 'Barangay health services are available this week.', 'All', 'Published', NOW()
      UNION ALL SELECT 'Scholarship Application Reminder', 'Residents may submit scholarship requirements through CommUnity.', 'Residents', 'Published', NOW()
    ) AS seed_announcements
    WHERE NOT EXISTS (SELECT 1 FROM announcements)
  `);
  await connection.query(`
    INSERT INTO system_settings (setting_key, setting_value, description)
    VALUES
      ('registration_enabled', 'true', 'Allow residents to submit public account registrations.'),
      ('default_service_visibility', 'own_barangay', 'Default visibility when creating new services.'),
      ('request_auto_notifications', 'true', 'Create resident notifications when request status changes.'),
      ('system_contact_email', 'admin@community.test', 'Primary contact email shown for system administration.')
    ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key)
  `);
  await connection.query(`
    INSERT INTO document_types (name, description, status)
    SELECT * FROM (
      SELECT 'Certificate of Indigency', 'Certifies that a resident is financially indigent for assistance or requirements.', 'Active'
      UNION ALL SELECT 'Barangay Clearance', 'Certifies residency and community record status for general transactions.', 'Active'
      UNION ALL SELECT 'Certificate of Residency', 'Certifies that a resident lives in the barangay.', 'Active'
      UNION ALL SELECT 'Business Clearance', 'Barangay clearance for local business-related transactions.', 'Active'
      UNION ALL SELECT 'Good Moral Certificate', 'Certifies good standing in the barangay community.', 'Active'
    ) AS seed_document_types
    WHERE NOT EXISTS (SELECT 1 FROM document_types)
  `);
};
// Entry point called at startup: runs all schema steps then seeds defaults.
export const ensureCoreSchema = async (connection) => {
  await ensureResidentSchema(connection);
  await ensureServiceSchema(connection);
  await ensurePhaseTwoSchema(connection);
  await seedPhaseTwoDefaults(connection);
};
