/**
 * GET /v1/audiences/:audienceId/contacts: the optional `order=id` cursor read,
 * and the default offset read it must leave alone.
 *
 * Runs through the real request handler and route table (test/support/api-server.ts)
 * against a real throwaway Postgres (local: DB_PORT=5433 pnpm test), because the
 * claim is about what the SQL returns across pages.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { contacts } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { createApiHandler } from './support/api-server';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp } from './support/seed';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { createApiKey } = await import('#app/models/api-keys.server');
const { createAudience } = await import('#app/models/audiences.server');
const { listContacts } = await import('#app/models/contacts.server');

const handleRequest = createApiHandler({
  modules: {
    'routes/_api.tsx': await import('#app/routes/_api'),
    'routes/api.v1.audiences.$audienceId.contacts.tsx': await import(
      '#app/routes/api.v1.audiences.$audienceId.contacts'
    ),
  },
});

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

interface Tenant {
  appId: string;
  audienceId: string;
  apiKey: string;
}

async function seedTenant(): Promise<Tenant> {
  const appId = await seedApp({ db: testDb.db });
  const audience = await createAudience({ appId, name: 'newsletter' });
  const { plaintext } = await createApiKey({ appId, name: 'cursor-test' });
  return { appId, audienceId: audience.id, apiKey: plaintext };
}

const EPOCH_MS = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Seeds `count` contacts, one minute apart, so the default order is fixed. The
 * returned emails are in insertion order, oldest first.
 */
async function seedContacts(opts: { tenant: Tenant; count: number }): Promise<string[]> {
  const emails = Array.from({ length: opts.count }, (_, index) => `person-${index}@example.com`);
  await testDb.db.insert(contacts).values(
    emails.map((email, index) => ({
      appId: opts.tenant.appId,
      audienceId: opts.tenant.audienceId,
      email,
      createdAt: new Date(EPOCH_MS + index * 60_000),
    })),
  );
  return emails;
}

/** The audience's ids in the database's own id order, which is the order a cursor walks. */
async function idsInDatabaseOrder(audienceId: string): Promise<string[]> {
  const rows = await testDb.db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.audienceId, audienceId))
    .orderBy(asc(contacts.id));
  return rows.map((row) => row.id);
}

interface ListBody {
  contacts: Array<{ id: string; email: string }>;
  limit: number;
  offset: number;
  nextCursor: string | null;
  error?: { code: string; message: string };
}

async function list(opts: { caller: Tenant; audienceId?: string; query?: string }) {
  const audienceId = opts.audienceId ?? opts.caller.audienceId;
  const response = await handleRequest(
    new Request(`http://pigeon.test/v1/audiences/${audienceId}/contacts?${opts.query ?? ''}`, {
      headers: { authorization: `Bearer ${opts.caller.apiKey}` },
    }),
  );
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as ListBody };
}

function idsOf(body: ListBody): string[] {
  return body.contacts.map((contact) => contact.id);
}

describe('GET contacts with order=id', () => {
  it('walks three pages in id order, with a cursor on each full page and null on the last', async () => {
    const tenant = await seedTenant();
    await seedContacts({ tenant, count: 7 });
    const expectedIds = await idsInDatabaseOrder(tenant.audienceId);

    const first = await list({ caller: tenant, query: 'order=id&limit=3' });
    const second = await list({ caller: tenant, query: `order=id&limit=3&after=${first.json.nextCursor}` });
    const third = await list({ caller: tenant, query: `order=id&limit=3&after=${second.json.nextCursor}` });

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(idsOf(first.json)).toEqual(expectedIds.slice(0, 3));
    expect(idsOf(second.json)).toEqual(expectedIds.slice(3, 6));
    expect(idsOf(third.json)).toEqual(expectedIds.slice(6));
    expect(first.json.nextCursor).toBe(expectedIds[2]);
    expect(second.json.nextCursor).toBe(expectedIds[5]);
    expect(third.json.nextCursor).toBeNull();
    expect(third.json.limit).toBe(3);
  });

  it('gives a full last page a cursor, and the page after it is empty with null', async () => {
    const tenant = await seedTenant();
    await seedContacts({ tenant, count: 4 });

    const first = await list({ caller: tenant, query: 'order=id&limit=2' });
    const second = await list({ caller: tenant, query: `order=id&limit=2&after=${first.json.nextCursor}` });
    const third = await list({ caller: tenant, query: `order=id&limit=2&after=${second.json.nextCursor}` });

    expect(second.json.contacts).toHaveLength(2);
    expect(second.json.nextCursor).not.toBeNull();
    expect(third.json.contacts).toEqual([]);
    expect(third.json.nextCursor).toBeNull();
  });

  it('a row removed between pages misses nothing', async () => {
    const tenant = await seedTenant();
    await seedContacts({ tenant, count: 6 });
    const allIds = await idsInDatabaseOrder(tenant.audienceId);

    const first = await list({ caller: tenant, query: 'order=id&limit=2' });
    const [readRowId, cursorRowId] = idsOf(first.json);
    await testDb.db.delete(contacts).where(eq(contacts.id, readRowId!));
    await testDb.db.delete(contacts).where(eq(contacts.id, cursorRowId!));
    const second = await list({ caller: tenant, query: `order=id&limit=2&after=${first.json.nextCursor}` });
    const third = await list({ caller: tenant, query: `order=id&limit=2&after=${second.json.nextCursor}` });

    expect([...idsOf(first.json), ...idsOf(second.json), ...idsOf(third.json)]).toEqual(allIds);
  });

  it('control: the same delete during an offset read does miss a contact', async () => {
    const tenant = await seedTenant();
    const emails = await seedContacts({ tenant, count: 4 });

    const first = await list({ caller: tenant, query: 'limit=2&offset=0' });
    await testDb.db.delete(contacts).where(eq(contacts.id, idsOf(first.json)[0]!));
    const second = await list({ caller: tenant, query: 'limit=2&offset=2' });

    const seen = [...first.json.contacts, ...second.json.contacts].map((contact) => contact.email);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(emails.filter((email) => !seen.includes(email))).toHaveLength(1);
  });

  it('walks every row of a bulk insert, where all rows share one timestamp', async () => {
    const tenant = await seedTenant();
    const createdAt = new Date(EPOCH_MS);
    await testDb.db.insert(contacts).values(
      Array.from({ length: 5 }, (_, index) => ({
        appId: tenant.appId,
        audienceId: tenant.audienceId,
        email: `bulk-${index}@example.com`,
        createdAt,
      })),
    );
    const allIds = await idsInDatabaseOrder(tenant.audienceId);

    const first = await list({ caller: tenant, query: 'order=id&limit=2' });
    const second = await list({ caller: tenant, query: `order=id&limit=2&after=${first.json.nextCursor}` });
    const third = await list({ caller: tenant, query: `order=id&limit=2&after=${second.json.nextCursor}` });

    expect([...idsOf(first.json), ...idsOf(second.json), ...idsOf(third.json)]).toEqual(allIds);
    expect(third.json.nextCursor).toBeNull();
  });

  it('caps the limit at 1000 and still gives a cursor on the capped page', async () => {
    const tenant = await seedTenant();
    await seedContacts({ tenant, count: 1001 });

    const first = await list({ caller: tenant, query: 'order=id&limit=5000' });
    const second = await list({ caller: tenant, query: `order=id&limit=5000&after=${first.json.nextCursor}` });

    expect(first.json.limit).toBe(1000);
    expect(first.json.contacts).toHaveLength(1000);
    expect(first.json.nextCursor).toBe(first.json.contacts.at(-1)?.id);
    expect(second.json.contacts).toHaveLength(1);
    expect(second.json.nextCursor).toBeNull();
  });
});

describe('GET contacts: bad cursor parameters answer 400 with the normal error shape', () => {
  it.each([
    ['after without order', 'after=abc'],
    ['after with another order', 'order=name&after=abc'],
    ['offset with order=id', 'order=id&offset=2'],
    ['offset=0 with order=id', 'order=id&offset=0'],
    ['after and offset with order=id', 'order=id&after=abc&offset=2'],
    ['an after of 129 characters', `order=id&after=${'a'.repeat(129)}`],
    ['an empty after', 'order=id&after='],
    ['a NUL in after', 'order=id&after=a%00b'],
    ['limit=0 with order=id', 'order=id&limit=0'],
    ['a negative limit with order=id', 'order=id&limit=-1'],
    ['a limit that is not a number with order=id', 'order=id&limit=abc'],
  ])('%s', async (_label, query) => {
    const tenant = await seedTenant();
    await seedContacts({ tenant, count: 1 });

    const { status, json } = await list({ caller: tenant, query });

    expect(status).toBe(400);
    expect(json).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
  });

  it('control: an after of exactly 128 characters is accepted', async () => {
    const tenant = await seedTenant();

    const { status } = await list({ caller: tenant, query: `order=id&after=${'a'.repeat(128)}` });

    expect(status).toBe(200);
  });
});

describe('GET contacts in default mode', () => {
  it('the default contact list keeps its order and fields', async () => {
    const tenant = await seedTenant();
    const emails = await seedContacts({ tenant, count: 3 });

    const { status, text, json } = await list({ caller: tenant });

    expect(status).toBe(200);
    expect(json.contacts.map((contact) => contact.email)).toEqual([...emails].reverse());
    expect(Object.keys(json)).toEqual(['contacts', 'limit', 'offset', 'nextCursor']);
    expect(json.limit).toBe(100);
    expect(json.offset).toBe(0);
    expect(json.nextCursor).toBeNull();
    const rows = await listContacts(tenant.audienceId, tenant.appId, { limit: 100, offset: 0 });
    expect(text).toBe(JSON.stringify({ contacts: rows, limit: 100, offset: 0, nextCursor: null }));
  });

  it('honours limit and offset, caps the limit, and has no cursor on a full page', async () => {
    const tenant = await seedTenant();
    const emails = await seedContacts({ tenant, count: 4 });

    const page = await list({ caller: tenant, query: 'limit=2&offset=1' });
    const capped = await list({ caller: tenant, query: 'limit=5000' });

    expect(page.json.contacts.map((contact) => contact.email)).toEqual([emails[2], emails[1]]);
    expect(page.json.limit).toBe(2);
    expect(page.json.offset).toBe(1);
    expect(page.json.nextCursor).toBeNull();
    expect(capped.json.limit).toBe(1000);
  });

  it('treats an order other than id as the default, as it always did', async () => {
    const tenant = await seedTenant();
    const emails = await seedContacts({ tenant, count: 2 });

    const { status, json } = await list({ caller: tenant, query: 'order=name&offset=1' });

    expect(status).toBe(200);
    expect(json.contacts.map((contact) => contact.email)).toEqual([emails[0]]);
    expect(json.nextCursor).toBeNull();
  });
});

describe('GET contacts: tenant scope', () => {
  it.each([
    ['default mode', ''],
    ['order=id', 'order=id'],
    ['order=id with a cursor below every id', 'order=id&after=0'],
  ])("returns nothing for another app's audience: %s", async (_label, query) => {
    const owner = await seedTenant();
    const stranger = await seedTenant();
    await seedContacts({ tenant: owner, count: 2 });

    const asStranger = await list({ caller: stranger, audienceId: owner.audienceId, query });
    const asOwner = await list({ caller: owner, query });

    expect(asStranger.status).toBe(200);
    expect(asStranger.json.contacts).toEqual([]);
    expect(asStranger.json.nextCursor).toBeNull();
    // Control: the rows are there for the app that owns them.
    expect(asOwner.json.contacts).toHaveLength(2);
  });

  it("leaves out a row of another app that sits in the caller's audience", async () => {
    const tenant = await seedTenant();
    const stranger = await seedTenant();
    await seedContacts({ tenant, count: 1 });
    await testDb.db
      .insert(contacts)
      .values({ appId: stranger.appId, audienceId: tenant.audienceId, email: 'stray@example.com' });

    const { json } = await list({ caller: tenant, query: 'order=id' });

    expect(json.contacts.map((contact) => contact.email)).toEqual(['person-0@example.com']);
  });
});
