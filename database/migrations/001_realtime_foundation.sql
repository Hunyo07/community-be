USE community_db;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  category ENUM('Medical', 'Livelihood', 'Social Welfare', 'Education', 'Infrastructure') NOT NULL,
  barangay VARCHAR(120) NOT NULL DEFAULT 'All Barangays',
  beneficiaries INT UNSIGNED NOT NULL DEFAULT 0,
  pending_requests INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('Active', 'Pending', 'Verified', 'Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

INSERT INTO services (name, category, barangay, beneficiaries, pending_requests, status)
SELECT * FROM (
  SELECT 'Medical Assistance', 'Medical', 'All Barangays', 1240, 84, 'Active'
  UNION ALL SELECT 'Livelihood Starter Kit', 'Livelihood', 'Mabini', 328, 26, 'Active'
  UNION ALL SELECT 'Senior Citizen Support', 'Social Welfare', 'Poblacion', 812, 41, 'Pending'
  UNION ALL SELECT 'Scholarship Program', 'Education', 'San Isidro', 460, 52, 'Active'
  UNION ALL SELECT 'Road Repair Tracking', 'Infrastructure', 'Bagong Silang', 2100, 13, 'Verified'
) AS seed_services
WHERE NOT EXISTS (SELECT 1 FROM services);

-- If your resident_accounts table already exists and does not have these fields,
-- add them manually in MySQL Workbench:
-- ALTER TABLE resident_accounts ADD COLUMN age INT UNSIGNED NULL AFTER barangay;
-- ALTER TABLE resident_accounts ADD COLUMN gender ENUM('Female', 'Male', 'Unspecified') NOT NULL DEFAULT 'Unspecified' AFTER age;

CREATE TABLE IF NOT EXISTS staff_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(180) NOT NULL,
  barangay VARCHAR(120) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'barangay_staff') NOT NULL,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_staff_email (email)
);
