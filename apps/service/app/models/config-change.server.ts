import { and, eq, sql } from 'drizzle-orm';
import { apps } from '#drizzle/schema/index';
import { db as defaultDb } from '#drizzle/db';
import type { Database, Executor, Transaction } from '#app/lib/db-types';
import { ConfigAppNotFoundError, StateVersionMismatchError } from '#app/lib/state-version';

/**
 * The one way to change an app's configuration (domains, audiences, webhooks,
 * inbound domains). See docs/concurrency.md.
 *
 * The bump runs FIRST, inside the transaction, as one UPDATE:
 *
 *   UPDATE apps SET state_version = state_version + 1
 *   WHERE id = $app [AND state_version = $expected]
 *   RETURNING state_version
 *
 * Its row lock serializes every configuration write of the app until commit.
 * A second writer waits for the lock, then Postgres re-checks the WHERE
 * against the committed row: with a stale `expected` it matches zero rows and
 * the write is refused before `run` starts. So `run` may make an external call
 * (SES) only after the check passed, and an exception from `run` rolls back
 * both the change and the bump.
 *
 * `run` must throw (ConfigItemNotFoundError, for example) when it changes
 * nothing, or the version counts a change that did not happen.
 */
export async function withConfigChange<T>(opts: {
  appId: string;
  /** The If-Match version, or null for an unconditional write. */
  expectedVersion: number | null;
  run: (tx: Transaction) => Promise<T>;
  db?: Database;
}): Promise<{ result: T; stateVersion: number }> {
  const { appId, expectedVersion, run, db = defaultDb } = opts;
  return db.transaction(async (tx) => {
    const stateVersion = await bumpStateVersion({ tx, appId, expectedVersion });
    const result = await run(tx);
    return { result, stateVersion };
  });
}

async function bumpStateVersion(opts: {
  tx: Transaction;
  appId: string;
  expectedVersion: number | null;
}): Promise<number> {
  const { tx, appId, expectedVersion } = opts;
  const where =
    expectedVersion === null
      ? eq(apps.id, appId)
      : and(eq(apps.id, appId), eq(apps.stateVersion, expectedVersion));

  const [bumped] = await tx
    .update(apps)
    .set({ stateVersion: sql`${apps.stateVersion} + 1` })
    .where(where)
    .returning({ stateVersion: apps.stateVersion });
  if (bumped) return bumped.stateVersion;

  const current = await readStateVersion({ appId, db: tx });
  if (current === null) throw new ConfigAppNotFoundError(appId);
  throw new StateVersionMismatchError({ expected: expectedVersion ?? current, current });
}

/**
 * The app's current state version, or null when the app does not exist.
 * A list route reads it BEFORE its list, so the list is never older than the
 * version it reports: a client that writes with this version gets a 412 if
 * anything changed after this read.
 */
export async function readStateVersion(opts: { appId: string; db?: Executor }): Promise<number | null> {
  const { appId, db = defaultDb } = opts;
  const [row] = await db.select({ stateVersion: apps.stateVersion }).from(apps).where(eq(apps.id, appId)).limit(1);
  return row?.stateVersion ?? null;
}
