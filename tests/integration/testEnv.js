import dotenv from 'dotenv';

// Reads the MySQL login from .env but ALWAYS uses a separate test database.
// The database name must end in "_test" so a real database can never be wiped.
export const getTestDbConfig = () => {
  dotenv.config({ path: new URL('../../.env', import.meta.url), quiet: true });

  const database = process.env.TEST_DB_NAME || 'community_test';
  if (!/_test$/.test(database)) {
    throw new Error(
      `Refusing to run integration tests: database "${database}" must end with "_test".`,
    );
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  };
};
