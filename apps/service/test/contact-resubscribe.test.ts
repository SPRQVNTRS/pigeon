/**
 * PATCH /v1/audiences/:audienceId/contacts/:id with `status: 'subscribed'`.
 *
 * Runs through the real request handler and route table (test/support/api-server.ts)
 * against a real throwaway Postgres (local: DB_PORT=5433 pnpm test). A tenant can
 * bring an unsubscribed contact back. It can never undo a bounce, a complaint or
 * a suppression-list entry, and it can never touch another app's contact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { contacts } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { createApiHandler } from './support/api-server';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp, seedSuppression } from './support/seed';

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

const handleRequest = createApiHandler({
  modules: {
    'routes/_api.tsx': await import('#app/routes/_api'),
    'routes/api.v1.audiences.$audienceId.contacts.$id.tsx': await import(
      '#app/routes/api.v1.audiences.$audienceId.contacts.$id'
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

const EARLIER = new Date('2026-01-01T00:00:00.000Z');

interface Tenant {
  appId: string;
  audienceId: string;
  apiKey: string;
}

async function seedTenant(): Promise<Tenant> {
  const appId = await seedApp({ db: testDb.db });
  const audience = await createAudience({ appId, name: 'newsletter' });
  const { plaintext } = await createApiKey({ appId, name: 'resubscribe-test' });
  return { appId, audienceId: audience.id, apiKey: plaintext };
}

async function seedContactRow(opts: {
  tenant: Tenant;
  email: string;
  overrides?: Partial<typeof contacts.$inferInsert>;
}): Promise<string> {
  const [row] = await testDb.db
    .insert(contacts)
    .values({
      appId: opts.tenant.appId,
      audienceId: opts.tenant.audienceId,
      email: opts.email,
      ...opts.overrides,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error('seedContactRow: no row returned');
  return row.id;
}

async function readContact(id: string) {
  const [row] = await testDb.db.select().from(contacts).where(eq(contacts.id, id));
  if (!row) throw new Error(`contact ${id} is gone`);
  return row;
}

async function patch(opts: { caller: Tenant; audienceId?: string; contactId: string; body: unknown }) {
  const audienceId = opts.audienceId ?? opts.caller.audienceId;
  const response = await handleRequest(
    new Request(`http://pigeon.test/v1/audiences/${audienceId}/contacts/${opts.contactId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${opts.caller.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(opts.body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe('PATCH contact status: subscribed', () => {
  it('turns an unsubscribed contact back into a subscribed one and clears unsubscribedAt', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'back@example.com',
      overrides: { status: 'unsubscribed', unsubscribedAt: EARLIER },
    });

    const { status, json } = await patch({ caller: tenant, contactId: id, body: { status: 'subscribed' } });

    expect(status).toBe(200);
    expect(json.contact.status).toBe('subscribed');
    expect(json.contact.unsubscribedAt).toBeNull();
    const row = await readContact(id);
    expect(row.status).toBe('subscribed');
    expect(row.unsubscribedAt).toBeNull();
  });

  it('answers 409 contact_suppressed for a bounced contact and changes nothing', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'bounced@example.com',
      overrides: { status: 'bounced', bouncedAt: EARLIER, unsubscribedAt: EARLIER },
    });
    const before = await readContact(id);

    const { status, json } = await patch({
      caller: tenant,
      contactId: id,
      body: { status: 'subscribed', firstName: 'Changed' },
    });

    expect(status).toBe(409);
    expect(json.error.code).toBe('contact_suppressed');
    expect(await readContact(id)).toEqual(before);
  });

  it('answers 409 contact_suppressed for a complained contact and changes nothing', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'complained@example.com',
      overrides: { status: 'complained', complainedAt: EARLIER, unsubscribedAt: EARLIER },
    });
    const before = await readContact(id);

    const { status, json } = await patch({ caller: tenant, contactId: id, body: { status: 'subscribed' } });

    expect(status).toBe(409);
    expect(json.error.code).toBe('contact_suppressed');
    expect(await readContact(id)).toEqual(before);
  });

  it('answers 409 for an unsubscribed contact whose address is on the suppression list', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'Listed@Example.com',
      overrides: { status: 'unsubscribed', unsubscribedAt: EARLIER },
    });
    await seedSuppression({ db: testDb.db, appId: tenant.appId, email: 'listed@example.com', reason: 'hard_bounce' });
    const before = await readContact(id);

    const { status, json } = await patch({ caller: tenant, contactId: id, body: { status: 'subscribed' } });

    expect(status).toBe(409);
    expect(json.error.code).toBe('contact_suppressed');
    expect(await readContact(id)).toEqual(before);
  });

  it('is not blocked by another app suppressing the same address', async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'shared@example.com',
      overrides: { status: 'unsubscribed', unsubscribedAt: EARLIER },
    });
    await seedSuppression({ db: testDb.db, appId: other.appId, email: 'shared@example.com', reason: 'complaint' });

    const { status } = await patch({ caller: tenant, contactId: id, body: { status: 'subscribed' } });

    expect(status).toBe(200);
  });

  it('answers 404 for another app\'s contact and leaves it unsubscribed', async () => {
    const tenant = await seedTenant();
    const other = await seedTenant();
    const id = await seedContactRow({
      tenant: other,
      email: 'theirs@example.com',
      overrides: { status: 'unsubscribed', unsubscribedAt: EARLIER },
    });
    const before = await readContact(id);

    const { status, json } = await patch({ caller: tenant, contactId: id, body: { status: 'subscribed' } });

    expect(status).toBe(404);
    expect(json.error.code).toBe('not_found');
    expect(await readContact(id)).toEqual(before);
  });

  it('leaves status and unsubscribedAt alone on a plain attributes PATCH', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({
      tenant,
      email: 'plain@example.com',
      overrides: { status: 'unsubscribed', unsubscribedAt: EARLIER },
    });

    const { status, json } = await patch({
      caller: tenant,
      contactId: id,
      body: { firstName: 'Ada', attributes: { plan: 'free' } },
    });

    expect(status).toBe(200);
    expect(json.contact.firstName).toBe('Ada');
    const row = await readContact(id);
    expect(row.attributes).toEqual({ plan: 'free' });
    expect(row.status).toBe('unsubscribed');
    expect(row.unsubscribedAt?.toISOString()).toBe(EARLIER.toISOString());
  });

  it('rejects status: unsubscribed with 400 and changes nothing', async () => {
    const tenant = await seedTenant();
    const id = await seedContactRow({ tenant, email: 'stay@example.com' });
    const before = await readContact(id);

    const { status, json } = await patch({ caller: tenant, contactId: id, body: { status: 'unsubscribed' } });

    expect(status).toBe(400);
    expect(json.error.code).toBe('invalid_request');
    expect(await readContact(id)).toEqual(before);
  });
});
