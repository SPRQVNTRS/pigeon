/**
 * Mail retention pass, against a real throwaway Postgres.
 *
 * Needs a reachable Postgres, see test/support/test-database.ts
 * (local: DB_PORT=5433 pnpm test).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailEvents, emails } from '#drizzle/schema/index';
import { runMailRetention } from '#app/lib/mail-retention';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { daysAgo, seedApp, seedEmail, seedEvent } from './support/seed';

// The pass logs per app; keep the test output readable.
vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

async function getEmail(id: string) {
  const [row] = await testDb.db.select().from(emails).where(eq(emails.id, id));
  return row;
}

async function eventExists(id: string): Promise<boolean> {
  const rows = await testDb.db.select({ id: emailEvents.id }).from(emailEvents).where(eq(emailEvents.id, id));
  return rows.length > 0;
}

describe('body limit', () => {
  it('blanks html, text and headers of an aged email and keeps the row', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db, mailBodyRetentionDays: 7 });
    const aged = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(8) } });

    await runMailRetention({ db });

    const row = await getEmail(aged);
    expect(row).toBeDefined();
    expect(row?.html).toBeNull();
    expect(row?.text).toBeNull();
    expect(row?.headers).toEqual({});
    expect(row?.toAddresses).toEqual(['someone@example.com']);
  });

  it('leaves a fresh email untouched', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db, mailBodyRetentionDays: 7 });
    const fresh = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(6) } });

    await runMailRetention({ db });

    const row = await getEmail(fresh);
    expect(row?.html).toBe('<p>body</p>');
    expect(row?.text).toBe('body');
    expect(row?.headers).toEqual({ 'X-Test': '1' });
  });

  it('leaves an old email of an app with NULL limits untouched', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db });
    const old = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(400) } });
    const event = await seedEvent({ db, appId, emailId: old, receivedAt: daysAgo(400) });

    const result = await runMailRetention({ db });

    const row = await getEmail(old);
    expect(row?.html).toBe('<p>body</p>');
    expect(await eventExists(event)).toBe(true);
    expect(result.perApp.find((a) => a.appId === appId)).toBeUndefined();
  });

  it('does not count rows that are already blank on a second run', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db, mailBodyRetentionDays: 7 });
    await seedEmail({ db, appId, overrides: { createdAt: daysAgo(8) } });

    const first = await runMailRetention({ db });
    const second = await runMailRetention({ db });

    expect(first.perApp.find((a) => a.appId === appId)?.bodiesBlanked).toBe(1);
    expect(second.perApp.find((a) => a.appId === appId)?.bodiesBlanked).toBe(0);
  });
});

describe('row limit', () => {
  it('deletes an aged email and its events, keeps a fresh email and its events', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db, mailRowRetentionDays: 30 });
    const aged = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(31) } });
    const agedEvent = await seedEvent({ db, appId, emailId: aged });
    const fresh = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(29) } });
    const freshEvent = await seedEvent({ db, appId, emailId: fresh });

    await runMailRetention({ db });

    expect(await getEmail(aged)).toBeUndefined();
    expect(await eventExists(agedEvent)).toBe(false);
    expect(await getEmail(fresh)).toBeDefined();
    expect(await eventExists(freshEvent)).toBe(true);
  });

  it('prunes an event whose received_at is past the limit even when its email is fresh', async () => {
    const { db } = testDb;
    const appId = await seedApp({ db, mailRowRetentionDays: 30 });
    const fresh = await seedEmail({ db, appId, overrides: { createdAt: daysAgo(1) } });
    const lateOld = await seedEvent({ db, appId, emailId: fresh, receivedAt: daysAgo(31) });
    const keep = await seedEvent({ db, appId, emailId: fresh, receivedAt: daysAgo(1) });

    await runMailRetention({ db });

    expect(await eventExists(lateOld)).toBe(false);
    expect(await eventExists(keep)).toBe(true);
  });

  it('never touches another app, even with older mail', async () => {
    const { db } = testDb;
    const limited = await seedApp({ db, mailRowRetentionDays: 30 });
    const other = await seedApp({ db });
    const otherOld = await seedEmail({ db, appId: other, overrides: { createdAt: daysAgo(500) } });
    await seedEmail({ db, appId: limited, overrides: { createdAt: daysAgo(31) } });

    await runMailRetention({ db });

    expect(await getEmail(otherOld)).toBeDefined();
  });
});
