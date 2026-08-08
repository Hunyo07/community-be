-- Baseline MySQL schema for CommUnity (tables for auth, residents, services, and more).
CREATE DATABASE IF NOT EXISTS community_db;
USE community_db;

CREATE TABLE IF NOT EXISTS posts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(160) NOT NULL,
  content TEXT NOT NULL,
  author VARCHAR(120) NOT NULL DEFAULT 'Anonymous',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

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
);

CREATE TABLE IF NOT EXISTS resident_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(180) NOT NULL,
  barangay VARCHAR(120) NOT NULL,
  age INT UNSIGNED NULL,
  gender ENUM('Female', 'Male', 'Unspecified') NOT NULL DEFAULT 'Unspecified',
  password_hash VARCHAR(255) NOT NULL,
  selfie_id_image VARCHAR(255) NULL,
  role ENUM('resident') NOT NULL DEFAULT 'resident',
  status ENUM('Pending', 'Verified', 'Active', 'Inactive', 'Rejected') NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_resident_email (email)
);

CREATE TABLE IF NOT EXISTS staff_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(180) NOT NULL,
  barangay VARCHAR(120) NULL,
  office_id INT UNSIGNED NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'barangay_staff') NOT NULL,
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_staff_email (email)
);

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  category ENUM('Medical', 'Livelihood', 'Social Welfare', 'Education', 'Infrastructure') NOT NULL,
  barangay VARCHAR(120) NOT NULL DEFAULT 'All Barangays',
  office_id INT UNSIGNED NULL,
  visibility ENUM('own_barangay', 'all_barangays', 'public') NOT NULL DEFAULT 'own_barangay',
  beneficiaries INT UNSIGNED NOT NULL DEFAULT 0,
  pending_requests INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('Active', 'Pending', 'Verified', 'Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

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
);

CREATE TABLE IF NOT EXISTS barangays (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  captain VARCHAR(160) NOT NULL DEFAULT '',
  contact VARCHAR(80) NOT NULL DEFAULT '',
  status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_barangay_name (name)
);

CREATE TABLE IF NOT EXISTS service_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  resident_id INT UNSIGNED NULL,
  service_id INT UNSIGNED NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NULL,
  status ENUM('Submitted', 'Under Review', 'Approved', 'Rejected', 'Processing', 'Completed', 'Cancelled') NOT NULL DEFAULT 'Submitted',
  priority ENUM('Low', 'Normal', 'High', 'Urgent') NOT NULL DEFAULT 'Normal',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(180) NOT NULL,
  content TEXT NOT NULL,
  audience ENUM('All', 'Residents', 'Barangay Staff', 'Admins') NOT NULL DEFAULT 'All',
  status ENUM('Draft', 'Published', 'Archived') NOT NULL DEFAULT 'Draft',
  published_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL,
  user_role VARCHAR(60) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  read_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

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
);

INSERT INTO posts (title, content, author)
VALUES
  ('Welcome to CommUnity', 'This is the first sample post from the API.', 'Admin'),
  ('MySQL is connected', 'If you can read this from the app, the database connection is working.', 'System');

INSERT INTO services (name, category, barangay, visibility, beneficiaries, pending_requests, status)
SELECT * FROM (
  SELECT 'Medical Assistance', 'Medical', 'All Barangays', 'public', 1240, 84, 'Active'
  UNION ALL SELECT 'Livelihood Starter Kit', 'Livelihood', 'Mabini', 'own_barangay', 328, 26, 'Active'
  UNION ALL SELECT 'Senior Citizen Support', 'Social Welfare', 'Poblacion', 'own_barangay', 812, 41, 'Pending'
  UNION ALL SELECT 'Scholarship Program', 'Education', 'San Isidro', 'all_barangays', 460, 52, 'Active'
  UNION ALL SELECT 'Road Repair Tracking', 'Infrastructure', 'Bagong Silang', 'public', 2100, 13, 'Verified'
) AS seed_services
WHERE NOT EXISTS (SELECT 1 FROM services);
