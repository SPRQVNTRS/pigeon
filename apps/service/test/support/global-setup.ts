/**
 * Vitest global setup: names this test run and drops its throwaway databases
 * once every file is done. See test-database-admin.ts for why the drop lives
 * here and not in each file's afterAll.
 *
 * Runs in the main process before any worker starts, so workers inherit the
 * run id through the environment.
 */
import { randomBytes } from 'node:crypto';
import { adminUrl, dropRunDatabases, TEST_RUN_ID_ENV } from './test-database-admin';

export default function setup(): () => Promise<void> {
  const runId = randomBytes(4).toString('hex');
  process.env[TEST_RUN_ID_ENV] = runId;

  return async function teardown(): Promise<void> {
    await dropRunDatabases({ baseUrl: adminUrl(), runId });
  };
}
