/**
 * App names are unique, enforced by the database (apps_name_idx), against a
 * real Postgres (test/support/test-database.ts, local: DB_PORT=5433 pnpm test).
 * A check-then-insert in application code cannot stop two concurrent creates;
 * only the index can, so only a real database can show it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { apps } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { createTestDatabase, type TestDatabase } from './support/test-database';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

const { AppNameTakenError, createApp } = await import('#app/models/apps.server');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

async function countNamed(name: string): Promise<number> {
  const rows = await testDb.db.select({ id: apps.id }).from(apps).where(eq(apps.name, name));
  return rows.length;
}

describe('createApp and the unique app name', () => {
  it('throws AppNameTakenError for a name another app has', async () => {
    await createApp({ name: 'unique-sequential' });
    const second = createApp({ name: 'unique-sequential' });
    await expect(second).rejects.toBeInstanceOf(AppNameTakenError);
    await expect(second).rejects.toThrow('An app named "unique-sequential" already exists');
    expect(await countNamed('unique-sequential')).toBe(1);
  });

  it('leaves exactly one app when many creates of one name race', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => createApp({ name: 'unique-race' })));
    const created = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof AppNameTakenError,
    );
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);
    expect(await countNamed('unique-race')).toBe(1);
  });

  it('still creates apps with different names', async () => {
    const [first, second] = await Promise.all([createApp({ name: 'unique-a' }), createApp({ name: 'unique-b' })]);
    expect(first.id).not.toBe(second.id);
  });
});
