/**
 * Throwaway Postgres database for tests that must run real SQL.
 *
 * A mocked drizzle chain cannot tell whether a WHERE clause deletes the right
 * rows, so the erase and retention tests run against a real database: this
 * helper creates a fresh one, applies the repo's migrations, installs pg-boss
 * in the default `pgboss` schema, and closes everything again.
 *
 * Connection: PIGEON_TEST_DB_ADMIN_URL, else DB_HOST/DB_PORT/DB_USER/DB_PASSWORD
 * (same variables as the app), pointed at the `postgres` maintenance database.
 * Local dev databases live in the shared Postgres on port 5433:
 *
 *   DB_PORT=5433 pnpm test
 *
 * Under vitest the databases of one run share a name prefix and the global
 * teardown drops them (see test-database-admin.ts). `drop()` then only closes
 * the connections the file opened. Outside vitest, where no run id is set,
 * `drop()` drops the database itself.
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createBoss } from '@sprqvntrs/workflows';
import * as schema from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { adminUrl, dropDatabase, runDatabasePrefix, TEST_RUN_ID_ENV } from './test-database-admin';

const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '../../drizzle/migrations');

function urlForDatabase(opts: { baseUrl: string; name: string }): string {
  const url = new URL(opts.baseUrl);
  url.pathname = `/${opts.name}`;
  return url.toString();
}

function newDatabaseName(): string {
  const suffix = randomBytes(6).toString('hex');
  const runId = process.env[TEST_RUN_ID_ENV];
  if (runId) return `${runDatabasePrefix(runId)}${suffix}`;
  return `pigeon_test_${suffix}`;
}

async function createDatabase(opts: { baseUrl: string; name: string }): Promise<void> {
  const admin = new pg.Client({ connectionString: opts.baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(opts.name)}`);
  } finally {
    await admin.end();
  }
}

export interface TestDatabase {
  db: Database;
  boss: ReturnType<typeof createBoss>;
  pool: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(opts: { queues?: string[] } = {}): Promise<TestDatabase> {
  const baseUrl = adminUrl();
  const name = newDatabaseName();
  await createDatabase({ baseUrl, name });

  const connectionString = urlForDatabase({ baseUrl, name });
  const pool = new pg.Pool({ connectionString, max: 4 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // The boss the service runs is the one @sprqvntrs/workflows builds, which is
  // pg-boss 10.4.2 and not the pg-boss 12 listed in package.json (see
  // app/lib/queue-job-retention.ts). Build it the same way. A one hour
  // maintenance interval keeps pg-boss from archiving rows mid-test.
  const boss = createBoss({ connectionString, maintenanceIntervalSeconds: 3600 });
  await boss.start();
  for (const queue of opts.queues ?? []) {
    await boss.createQueue(queue);
  }

  return {
    db,
    boss,
    pool,
    async drop() {
      await boss.stop({ graceful: false });
      await pool.end();
      if (process.env[TEST_RUN_ID_ENV]) return;
      await dropDatabase({ baseUrl, name });
    },
  };
}
