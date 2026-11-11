/**
 * A stand-in for app/models/config-change.server.ts in route tests that mock
 * `#drizzle/db` with a fake chain. `run` gets that fake db as its transaction,
 * so the route's model calls hit the same mocks as before, and every write
 * reports state version 1. Use it with:
 *
 *   vi.mock('#app/models/config-change.server', () => import('../support/config-change-passthrough'));
 *
 * The real transaction, bump and conflict behaviour is covered against a real
 * database in test/config-change.test.ts.
 */
import { db } from '#drizzle/db';
import type { Transaction } from '#app/lib/db-types';

export const PASSTHROUGH_STATE_VERSION = 1;

export async function withConfigChange<T>(opts: {
  appId: string;
  expectedVersion: number | null;
  run: (tx: Transaction) => Promise<T>;
}): Promise<{ result: T; stateVersion: number }> {
  return { result: await opts.run(db as unknown as Transaction), stateVersion: PASSTHROUGH_STATE_VERSION };
}

export async function readStateVersion(): Promise<number> {
  return PASSTHROUGH_STATE_VERSION - 1;
}
