/**
 * The HTTP side of the state version (docs/concurrency.md), against a real
 * Postgres (test/support/test-database.ts, local: DB_PORT=5433 pnpm test):
 *
 * - every read of one app's configuration carries Pigeon-State-Version
 * - a write answers with the new version, takes If-Match quoted or bare,
 *   answers 412 with the expected and current version and changes nothing,
 *   and answers 400 to a malformed If-Match
 * - a stale If-Match on a domain register never reaches SES
 * - worker verification updates and contact writes do not bump the version
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityDkimSigningAttributesCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { audiences, domains, webhooks } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { resetSesClients } from '#app/lib/ses/client';
import { STATE_VERSION_HEADER } from '#app/lib/state-version';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp, seedWebhook } from './support/seed';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

const boss = vi.hoisted(() => ({ send: vi.fn(async () => 'job-id') }));
vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => boss }),
}));

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

const adminApp = await import('../app/routes/api.v1.admin.apps.$id');
const adminDomains = await import('../app/routes/api.v1.admin.apps.$id.domains');
const adminAudiences = await import('../app/routes/api.v1.admin.apps.$id.audiences');
const adminWebhooks = await import('../app/routes/api.v1.admin.apps.$id.webhooks');
const adminInbound = await import('../app/routes/api.v1.admin.apps.$id.inbound-domains');
const adminRotate = await import('../app/routes/api.v1.admin.apps.$id.webhooks.$webhookId.rotate');
const tenantAudiences = await import('../app/routes/api.v1.audiences');
const tenantAudience = await import('../app/routes/api.v1.audiences.$id');
const tenantDomains = await import('../app/routes/api.v1.domains');
const tenantContacts = await import('../app/routes/api.v1.audiences.$audienceId.contacts');
const { readStateVersion } = await import('#app/models/config-change.server');
const { registerDomainVerifyWorker } = await import('#app/workflows/domain-verify');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

const sesMock = mockClient(SESv2Client);
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

beforeEach(() => {
  sesMock.reset();
  resetSesClients();
  boss.send.mockClear();
});

afterEach(() => {
  sesMock.reset();
  resetSesClients();
});

function tenantContext(appId: string) {
  return { get: () => ({ appId, apiKeyId: 'key-test', keyPrefix: 'ske_test' }) };
}

function request(opts: { path: string; method?: string; body?: unknown; ifMatch?: string }): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.ifMatch !== undefined) headers['If-Match'] = opts.ifMatch;
  return new Request(`http://localhost${opts.path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function versionOf(response: unknown): string | null {
  expect(response).toBeInstanceOf(Response);
  return (response as Response).headers.get(STATE_VERSION_HEADER);
}

async function audienceCount(appId: string): Promise<number> {
  const rows = await testDb.db.select({ id: audiences.id }).from(audiences).where(eq(audiences.appId, appId));
  return rows.length;
}

function createAudience(opts: { appId: string; name: string; ifMatch?: string }) {
  return tenantAudiences.action({
    request: request({ path: '/v1/audiences', method: 'POST', body: { name: opts.name }, ifMatch: opts.ifMatch }),
    context: tenantContext(opts.appId),
    params: {},
  } as AnyArgs) as Promise<Response>;
}

describe('reads carry Pigeon-State-Version', () => {
  it('reports the same version on every configuration read of the app', async () => {
    const appId = await seedApp({ db: testDb.db });
    await createAudience({ appId, name: 'bump-once' });
    const args = { request: request({ path: '/' }), params: { id: appId } } as AnyArgs;

    const reads = await Promise.all([
      adminApp.loader(args),
      adminDomains.loader(args),
      adminAudiences.loader(args),
      adminWebhooks.loader(args),
      adminInbound.loader(args),
      tenantAudiences.loader({ ...args, context: tenantContext(appId) }),
      tenantDomains.loader({ ...args, context: tenantContext(appId) }),
    ]);

    expect(reads.map(versionOf)).toEqual(['1', '1', '1', '1', '1', '1', '1']);
    expect((await (reads[0] as Response).json()).app.stateVersion).toBe(1);
  });

  it('sends no version with a 404 for an unknown app', async () => {
    const response = await adminDomains.loader({ request: request({ path: '/' }), params: { id: 'nope' } } as AnyArgs);
    expect((response as Response).status).toBe(404);
    expect(versionOf(response)).toBeNull();
  });
});

describe('writes and If-Match', () => {
  it('answers a write with the new version, for a bare and a quoted If-Match', async () => {
    const appId = await seedApp({ db: testDb.db });

    const bare = await createAudience({ appId, name: 'a', ifMatch: '0' });
    expect(bare.status).toBe(201);
    expect(versionOf(bare)).toBe('1');

    const quoted = await createAudience({ appId, name: 'b', ifMatch: '"1"' });
    expect(quoted.status).toBe(201);
    expect(versionOf(quoted)).toBe('2');

    const unconditional = await createAudience({ appId, name: 'c' });
    expect(versionOf(unconditional)).toBe('3');
  });

  it('answers 412 with expected and current on a stale If-Match, and changes nothing', async () => {
    const appId = await seedApp({ db: testDb.db });
    await createAudience({ appId, name: 'first' });

    const stale = await createAudience({ appId, name: 'second', ifMatch: '"0"' });

    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ error: 'state_version_mismatch', expected: 0, current: 1 });
    expect(versionOf(stale)).toBe('1');
    expect(await audienceCount(appId)).toBe(1);
    expect(await readStateVersion({ appId })).toBe(1);
  });

  it.each(['abc', '"1', '*', 'W/"1"', '1, 2', '-1', '99999999999', ''])(
    'answers 400 to the malformed If-Match %j and changes nothing',
    async (ifMatch) => {
      const appId = await seedApp({ db: testDb.db });
      const response = await createAudience({ appId, name: 'x', ifMatch });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('invalid_if_match');
      expect(await audienceCount(appId)).toBe(0);
      expect(await readStateVersion({ appId })).toBe(0);
    },
  );

  it('does not bump on a 404: deleting an unknown audience leaves the version alone', async () => {
    const appId = await seedApp({ db: testDb.db });
    const response = await tenantAudience.action({
      request: request({ path: '/v1/audiences/nope', method: 'DELETE' }),
      context: tenantContext(appId),
      params: { id: 'nope' },
    } as AnyArgs);
    expect((response as Response).status).toBe(404);
    expect(await readStateVersion({ appId })).toBe(0);
  });

  it('rotates a webhook secret only when If-Match is current', async () => {
    const appId = await seedApp({ db: testDb.db });
    const webhookId = await seedWebhook({ db: testDb.db, appId });
    const rotate = (ifMatch: string) =>
      adminRotate.action({
        request: request({ path: '/rotate', method: 'POST', ifMatch }),
        params: { id: appId, webhookId },
      } as AnyArgs) as Promise<Response>;

    const ok = await rotate('0');
    expect(ok.status).toBe(200);
    expect(versionOf(ok)).toBe('1');
    const [afterOk] = await testDb.db.select().from(webhooks).where(eq(webhooks.id, webhookId));

    const stale = await rotate('0');
    expect(stale.status).toBe(412);
    const [afterStale] = await testDb.db.select().from(webhooks).where(eq(webhooks.id, webhookId));
    expect(afterStale?.signingSecret).toBe(afterOk?.signingSecret);
  });

  it('never calls SES when a domain register has a stale If-Match', async () => {
    const appId = await seedApp({ db: testDb.db });
    await createAudience({ appId, name: 'bump' });
    sesMock.on(CreateEmailIdentityCommand).resolves({});

    const response = (await tenantDomains.action({
      request: request({ path: '/v1/domains', method: 'POST', body: { name: 'mail.stale.example.test' }, ifMatch: '0' }),
      context: tenantContext(appId),
      params: {},
    } as AnyArgs)) as Response;

    expect(response.status).toBe(412);
    expect(sesMock.commandCalls(CreateEmailIdentityCommand)).toHaveLength(0);
    expect(boss.send).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(domains).where(eq(domains.appId, appId))).toEqual([]);
  });

  it('registers a domain with a current If-Match and queues the verify job after commit', async () => {
    const appId = await seedApp({ db: testDb.db });
    sesMock.on(CreateEmailIdentityCommand).resolves({});
    sesMock.on(PutEmailIdentityDkimSigningAttributesCommand).resolves({});
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: 'PENDING', Tokens: ['t1', 't2', 't3'], SigningEnabled: true },
    });

    const response = (await tenantDomains.action({
      request: request({ path: '/v1/domains', method: 'POST', body: { name: 'mail.fresh.example.test' }, ifMatch: '"0"' }),
      context: tenantContext(appId),
      params: {},
    } as AnyArgs)) as Response;

    expect(response.status).toBe(201);
    expect(versionOf(response)).toBe('1');
    expect(boss.send).toHaveBeenCalledWith('domain.verify', expect.any(Object), expect.any(Object));
  });
});

describe('writes that are not configuration do not bump', () => {
  it('leaves the version alone when the verify worker updates a domain', async () => {
    const appId = await seedApp({ db: testDb.db });
    const [domain] = await testDb.db
      .insert(domains)
      .values({ appId, name: 'mail.verify.example.test', dkimTokens: ['t1', 't2', 't3'] })
      .returning({ id: domains.id });
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'SUCCESS', Tokens: ['t1', 't2', 't3'], SigningEnabled: true },
    });

    let handler: ((jobs: Array<{ data: { domainId: string } }>) => Promise<void>) | undefined;
    await registerDomainVerifyWorker({
      createQueue: async () => undefined,
      work: (_name, _options, registered) => {
        handler = registered as typeof handler;
      },
    });
    await handler?.([{ data: { domainId: domain!.id } }]);

    const [after] = await testDb.db.select().from(domains).where(eq(domains.id, domain!.id));
    expect(after?.dkimStatus).toBe('verified');
    expect(await readStateVersion({ appId })).toBe(0);
  });

  it('leaves the version alone when a contact is added', async () => {
    const appId = await seedApp({ db: testDb.db });
    const created = await createAudience({ appId, name: 'list' });
    const { audience } = (await created.json()) as { audience: { id: string } };

    const response = await tenantContacts.action({
      request: request({
        path: `/v1/audiences/${audience.id}/contacts`,
        method: 'POST',
        body: { email: 'reader@example.com' },
      }),
      context: tenantContext(appId),
      params: { audienceId: audience.id },
    } as AnyArgs);

    expect((response as Response).status).toBe(201);
    expect(await readStateVersion({ appId })).toBe(1);
  });
});
