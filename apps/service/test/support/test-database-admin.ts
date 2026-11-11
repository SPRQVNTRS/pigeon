/**
 * Admin side of the throwaway test databases: where the server is, how a
 * database of one test run is named, and how a run's databases are dropped.
 *
 * Why the drop is not done by each test file: `DROP DATABASE` makes Postgres
 * run an immediate, forced checkpoint and wait for it. On a shared server that
 * checkpoint fsyncs every dirty relation file of every database, which took 5 to
 * 35 seconds while other test files were migrating, and two files that finished
 * together shared one such wait. A per-file `afterAll` that dropped its database
 * therefore crossed its 30 second hook limit about every second run. Each file
 * now only closes its connections (see test-database.ts) and the vitest global
 * teardown (global-setup.ts) drops the run's databases in one pass, where
 * concurrent drops share checkpoints and no hook timer is running.
 */
import pg from 'pg';

/** Set by global-setup.ts before any test worker starts. */
export const TEST_RUN_ID_ENV = 'PIGEON_TEST_RUN_ID';

const DATABASE_PREFIX = 'pigeon_test_';
const DROP_CONCURRENCY = 5;

export function adminUrl(): string {
  const explicit = process.env.PIGEON_TEST_DB_ADMIN_URL;
  if (explicit) return explicit;
  const host = process.env.DB_HOST ?? 'localhost';
  const port = process.env.DB_PORT ?? '5432';
  const user = process.env.DB_USER ?? 'postgres';
  const password = process.env.DB_PASSWORD ?? 'postgres';
  return `postgres://${user}:${password}@${host}:${port}/postgres`;
}

/** The name prefix shared by every database one test run creates. */
export function runDatabasePrefix(runId: string): string {
  return `${DATABASE_PREFIX}${runId}_`;
}

/** Drops one database. `FORCE` ends any connection a straggler still holds. */
export async function dropDatabase(opts: { baseUrl: string; name: string }): Promise<void> {
  const client = new pg.Client({ connectionString: opts.baseUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(opts.name)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/**
 * Drops every database whose name starts with the run's prefix, a few at a
 * time. Throws after trying all of them when any drop failed, so a leak shows
 * up in the test output. Returns the names it dropped.
 */
export async function dropRunDatabases(opts: { baseUrl: string; runId: string }): Promise<string[]> {
  const names = await listRunDatabases(opts);
  const failures: string[] = [];
  for (let start = 0; start < names.length; start += DROP_CONCURRENCY) {
    const batch = names.slice(start, start + DROP_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((name) => dropDatabase({ baseUrl: opts.baseUrl, name })));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      failures.push(`${batch[index]}: ${String(result.reason)}`);
    });
  }
  if (failures.length > 0) {
    throw new Error(`Could not drop ${failures.length} test database(s):\n${failures.join('\n')}`);
  }
  return names;
}

async function listRunDatabases(opts: { baseUrl: string; runId: string }): Promise<string[]> {
  const client = new pg.Client({ connectionString: opts.baseUrl });
  await client.connect();
  try {
    // starts_with, not LIKE: the underscores in the prefix are LIKE wildcards.
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname',
      [runDatabasePrefix(opts.runId)],
    );
    return rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}
