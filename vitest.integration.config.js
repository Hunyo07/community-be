   import { defineConfig } from 'vitest/config';
   import { getTestDbConfig } from './tests/integration/testEnv.js';

   const db = getTestDbConfig();

   // Integration tests: real Express app + real MySQL (database "community_test").
   export default defineConfig({
     test: {
       include: ['tests/integration/**/*.test.js'],
       globalSetup: ['tests/integration/globalSetup.js'],
       // Test files share one database, so run them one after another.
       fileParallelism: false,
       testTimeout: 20000,
       hookTimeout: 30000,
       env: {
         NODE_ENV: 'test',
         JWT_SECRET: 'integration-test-secret',
         DB_HOST: db.host,
         DB_PORT: String(db.port),
         DB_USER: db.user ?? '',
         DB_PASSWORD: db.password ?? '',
         DB_NAME: db.database,
         // Never send real email from tests, even if .env has Gmail credentials.
         // Empty values make the mailer report "not configured" instead of sending.
         GMAIL_USER: '',
         GMAIL_APP_PASSWORD: '',
       },
     },
   });