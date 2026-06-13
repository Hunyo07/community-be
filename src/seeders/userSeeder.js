import { pool } from '../config/db.js';
import { ensureCoreSchema } from '../database/ensureSchema.js';
import { normalizePermissions } from '../rbac/roles.js';
import { hashPassword } from '../utils/password.js';

const defaultPassword = 'Resident@123';

const users = [
  {
    firstName: 'Maria',
    lastName: 'Santos',
    email: 'maria.santos@community.test',
    barangay: 'San Isidro',
    birthDate: '1992-03-18',
    age: 34,
    gender: 'Female',
    verificationStatus: 'Verified',
    accountStatus: 'Active'
  },
  {
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    email: 'juan.delacruz@community.test',
    barangay: 'Mabini',
    birthDate: '1984-07-09',
    age: 42,
    gender: 'Male',
    verificationStatus: 'Verified',
    accountStatus: 'Active'
  },
  {
    firstName: 'Angela',
    lastName: 'Reyes',
    email: 'angela.reyes@community.test',
    barangay: 'Poblacion',
    birthDate: '1998-01-22',
    age: 28,
    gender: 'Female',
    verificationStatus: 'Pending',
    accountStatus: 'Inactive'
  },
  {
    firstName: 'Ramon',
    lastName: 'Garcia',
    email: 'ramon.garcia@community.test',
    barangay: 'Bagong Silang',
    birthDate: '1959-11-04',
    age: 67,
    gender: 'Male',
    verificationStatus: 'Verified',
    accountStatus: 'Active'
  },
  {
    firstName: 'Liza',
    lastName: 'Mendoza',
    email: 'liza.mendoza@community.test',
    barangay: 'Maligaya',
    birthDate: '1975-05-16',
    age: 51,
    gender: 'Female',
    verificationStatus: 'Verified',
    accountStatus: 'Inactive'
  },
  {
    firstName: 'Noel',
    lastName: 'Aquino',
    email: 'noel.aquino@community.test',
    barangay: 'San Isidro',
    birthDate: '2003-08-30',
    age: 23,
    gender: 'Male',
    verificationStatus: 'Verified',
    accountStatus: 'Active'
  },
  {
    firstName: 'Catherine',
    lastName: 'Flores',
    email: 'catherine.flores@community.test',
    barangay: 'Poblacion',
    birthDate: '1987-12-11',
    age: 39,
    gender: 'Female',
    verificationStatus: 'Pending',
    accountStatus: 'Inactive'
  },
  {
    firstName: 'Mark',
    lastName: 'Villanueva',
    email: 'mark.villanueva@community.test',
    barangay: 'Mabini',
    birthDate: '1995-02-24',
    age: 31,
    gender: 'Male',
    verificationStatus: 'Rejected',
    accountStatus: 'Inactive'
  }
];

const staffUsers = [
  {
    name: 'CommUnity Admin',
    email: 'admin@community.test',
    barangay: null,
    role: 'admin',
    status: 'Active'
  },
  {
    name: 'San Isidro Staff',
    email: 'sanisidro.staff@community.test',
    barangay: 'San Isidro',
    officeName: 'Barangay Secretary Office',
    role: 'barangay_staff',
    status: 'Active'
  },
  {
    name: 'Mabini Staff',
    email: 'mabini.staff@community.test',
    barangay: 'Mabini',
    officeName: 'Social Welfare Office',
    role: 'barangay_staff',
    status: 'Active'
  },
  {
    name: 'Poblacion Staff',
    email: 'poblacion.staff@community.test',
    barangay: 'Poblacion',
    officeName: 'Barangay Secretary Office',
    role: 'barangay_staff',
    status: 'Active'
  }
];

const seedUsers = async () => {
  const connection = await pool.getConnection();

  try {
    await ensureCoreSchema(connection);
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM staff_accounts
       WHERE email IN ('superadmin@community.test', 'municipal.admin@community.test')
          OR role IN ('super_admin', 'municipal_admin')`
    );

    for (const user of users) {
      await connection.execute(
        `INSERT INTO resident_accounts
          (first_name, last_name, email, barangay, birth_date, age, gender, password_hash, selfie_id_image, role, verification_status, account_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'resident', ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          first_name = VALUES(first_name),
          last_name = VALUES(last_name),
          barangay = VALUES(barangay),
          birth_date = VALUES(birth_date),
          age = VALUES(age),
          gender = VALUES(gender),
          verification_status = VALUES(verification_status),
          account_status = VALUES(account_status),
          status = VALUES(status)`,
        [
          user.firstName,
          user.lastName,
          user.email,
          user.barangay,
          user.birthDate,
          user.age,
          user.gender,
          hashPassword(defaultPassword),
          `seeded/${user.email}-selfie-id.jpg`,
          user.verificationStatus,
          user.accountStatus,
          user.verificationStatus === 'Verified' ? user.accountStatus : user.verificationStatus
        ]
      );
    }

    for (const staff of staffUsers) {
      const [[office]] = staff.officeName
        ? await connection.execute('SELECT id FROM offices WHERE name = ? AND barangay = ? LIMIT 1', [
            staff.officeName,
            staff.barangay
          ])
        : [[null]];

      await connection.execute(
        `INSERT INTO staff_accounts
          (name, email, barangay, office_id, password_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          barangay = VALUES(barangay),
          office_id = VALUES(office_id),
          role = VALUES(role),
          permissions = VALUES(permissions),
          status = VALUES(status)`,
        [
          staff.name,
          staff.email,
          staff.barangay,
          office?.id || null,
          hashPassword(defaultPassword),
          staff.role,
          JSON.stringify(normalizePermissions(staff.permissions, staff.role)),
          staff.status
        ]
      );
    }

    await connection.commit();

    console.log(`Seeded ${users.length} resident users and ${staffUsers.length} staff users.`);
    console.log(`Default seeded password: ${defaultPassword}`);
  } catch (error) {
    await connection.rollback();
    console.error('Failed to seed resident users.');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    connection.release();
    await pool.end();
  }
};

seedUsers();
