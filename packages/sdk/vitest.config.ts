import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Contract tests live under test/contract/ and require a running service.
    // They are gated via CONTRACT_TEST_BASE_URL and skip themselves when unset,
    // but we still exclude them from the default run to avoid confusion.
    exclude: ['test/contract/**', 'node_modules/**', 'dist/**'],
  },
});
