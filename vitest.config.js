import { configDefaults, defineConfig } from 'vitest/config';

// `npm test` runs only the fast unit tests. Integration tests need MySQL,
// so they run separately with `npm run test:integration`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
  },
});
