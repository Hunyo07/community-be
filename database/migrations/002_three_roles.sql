USE community_db;

ALTER TABLE staff_accounts
MODIFY role ENUM('admin', 'barangay_staff', 'super_admin', 'municipal_admin') NOT NULL;

UPDATE staff_accounts
SET role = 'admin'
WHERE role IN ('super_admin', 'municipal_admin');

ALTER TABLE staff_accounts
MODIFY role ENUM('admin', 'barangay_staff') NOT NULL;

DELETE FROM staff_accounts
WHERE email IN ('superadmin@community.test', 'municipal.admin@community.test');
