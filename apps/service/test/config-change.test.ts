/**
 * withConfigChange against a real Postgres (test/support/test-database.ts,
 * local: DB_PORT=5433 pnpm test). A mocked transaction cannot show the row
 * lock, the re-check of the WHERE after the lock wait, or the rollback, and
 * those are the whole point of the helper.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { apps, audiences } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { ConfigAppNotFoundError, StateVersionMismatchError } from '#app/lib/state-version';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp } from './support/seed';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

const { withConfigChange, readStateVersion } = await import('#app/models/config-change.server');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

async function audienceNames(appId: string): Promise<string[]> {
  const rows = await testDb.db.select({ name: audiences.name }).from(audiences).where(eq(audiences.appId, appId));
  return rows.map((row) => row.name).sort();
}

function addAudience(opts: { appId: string; name: string; expectedVersion: number | null }) {
  return withConfigChange({
    appId: opts.appId,
    expectedVersion: opts.expectedVersion,
    run: async (tx) => {
      await tx.insert(audiences).values({ appId: opts.appId, name: opts.name });
      return opts.name;
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('withConfigChange', () => {
  it('starts a new app at 0 and bumps by one per unconditional write', async () => {
    const appId = await seedApp({ db: testDb.db });
    expect(await readStateVersion({ appId })).toBe(0);

    const first = await addAudience({ appId, name: 'one', expectedVersion: null });
    const second = await addAudience({ appId, name: 'two', expectedVersion: null });

    expect(first).toEqual({ result: 'one', stateVersion: 1 });
    expect(second.stateVersion).toBe(2);
    expect(await readStateVersion({ appId })).toBe(2);
  });

  it('commits a conditional write whose expected version is current', async () => {
    const appId = await seedApp({ db: testDb.db });
    const result = await addAudience({ appId, name: 'news', expectedVersion: 0 });
    expect(result.stateVersion).toBe(1);
    expect(await audienceNames(appId)).toEqual(['news']);
  });

  it('refuses a stale conditional write before run, and changes nothing', async () => {
    const appId = await seedApp({ db: testDb.db });
    await addAudience({ appId, name: 'first', expectedVersion: null });
    const run = vi.fn();

    const attempt = withConfigChange({ appId, expectedVersion: 0, run });

    await expect(attempt).rejects.toBeInstanceOf(StateVersionMismatchError);
    await expect(attempt).rejects.toMatchObject({ expected: 0, current: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(await readStateVersion({ appId })).toBe(1);
    expect(await audienceNames(appId)).toEqual(['first']);
  });

  it('rolls back the bump and the change when run throws', async () => {
    const appId = await seedApp({ db: testDb.db });
    const attempt = withConfigChange({
      appId,
      expectedVersion: 0,
      run: async (tx) => {
        await tx.insert(audiences).values({ appId, name: 'half-done' });
        throw new Error('external call failed');
      },
    });

    await expect(attempt).rejects.toThrow('external call failed');
    expect(await readStateVersion({ appId })).toBe(0);
    expect(await audienceNames(appId)).toEqual([]);
  });

  it('throws ConfigAppNotFoundError for an unknown app, with and without a version', async () => {
    await expect(addAudience({ appId: 'no-such-app', name: 'x', expectedVersion: null })).rejects.toBeInstanceOf(
      ConfigAppNotFoundError,
    );
    await expect(addAudience({ appId: 'no-such-app', name: 'x', expectedVersion: 0 })).rejects.toBeInstanceOf(
      ConfigAppNotFoundError,
    );
    expect(await readStateVersion({ appId: 'no-such-app' })).toBeNull();
  });

  it('makes a second writer with the same expected version wait for the lock, then refuses it', async () => {
    const appId = await seedApp({ db: testDb.db });
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstInside: () => void = () => undefined;
    const firstIsInside = new Promise<void>((resolve) => {
      markFirstInside = resolve;
    });

    const first = withConfigChange({
      appId,
      expectedVersion: 0,
      run: async (tx) => {
        await tx.insert(audiences).values({ appId, name: 'winner' });
        markFirstInside();
        await firstMayCommit;
        return 'winner';
      },
    });
    await firstIsInside;

    let secondSettled = false;
    const second = addAudience({ appId, name: 'loser', expectedVersion: 0 }).finally(() => {
      secondSettled = true;
    });
    const secondOutcome = second.then(
      () => 'committed',
      (error: unknown) => error,
    );

    await sleep(300);
    expect(secondSettled).toBe(false);

    releaseFirst();
    expect((await first).stateVersion).toBe(1);
    const outcome = await secondOutcome;
    expect(outcome).toBeInstanceOf(StateVersionMismatchError);
    expect(outcome).toMatchObject({ expected: 0, current: 1 });
    expect(await audienceNames(appId)).toEqual(['winner']);
  });

  it('lets exactly one of eight concurrent writers with the same expected version win', async () => {
    const appId = await seedApp({ db: testDb.db });
    const names = Array.from({ length: 8 }, (_, index) => `racer-${index}`);

    const outcomes = await Promise.allSettled(
      names.map((name) => addAudience({ appId, name, expectedVersion: 0 })),
    );

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    for (const loser of losers) expect(loser.reason).toBeInstanceOf(StateVersionMismatchError);
    expect(await readStateVersion({ appId })).toBe(1);
    expect(await audienceNames(appId)).toHaveLength(1);
  });

  it('loses no bump when eight unconditional writers run at once', async () => {
    const appId = await seedApp({ db: testDb.db });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => addAudience({ appId, name: `bulk-${index}`, expectedVersion: null })),
    );

    expect(results.map((result) => result.stateVersion).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [row] = await testDb.db.select({ stateVersion: apps.stateVersion }).from(apps).where(eq(apps.id, appId));
    expect(row?.stateVersion).toBe(8);
  });
});
