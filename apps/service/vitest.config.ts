import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['test/support/global-setup.ts'],
    include: [
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'drizzle/**/*.test.ts',
      'scripts/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    exclude: ['node_modules', 'build', '.react-router'],
  },
});
