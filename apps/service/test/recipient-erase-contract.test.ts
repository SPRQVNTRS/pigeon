/**
 * Contract test: replay the erase request a consumer's core service really sends.
 *
 * test/fixtures/erase-contract/pigeon-erase-request.json is a byte for byte
 * copy of the fixture the core commits and sends from its own test (see
 * PROVENANCE next to it). The request below is built from that file alone:
 * method, path, header values and body. Only the secret header is minted here,
 * from a real API key of app A that the test creates, so the key is checked by
 * the real middleware and not waved through.
 *
 * The request goes through the real React Router request handler for the real
 * route table (test/support/api-server.ts), so the path match, the `_api`
 * layout middleware and the 404 for an unknown path all run. The database is a
 * real throwaway Postgres with pg-boss installed (local: DB_PORT=5433 pnpm test).
 * Only SES, S3 and the mail send are faked, because nothing here may reach AWS.
 *
 * The second half covers the one field of the core's mail request that Pigeon
 * must honour: `retain_body: false` (snake_case) on POST /v1/emails.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteSuppressedDestinationCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { contacts, domains, emailEvents, emails, inboundEmails, suppressions } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { createApiHandler } from './support/api-server';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import {
  seedApp,
  seedContact,
  seedEmail,
  seedEvent,
  seedInboundEmail,
  seedSuppression,
  seedWebhook,
} from './support/seed';
import { jobExists, queueEmailJob, queueInboundDeliveryJob, queueInboundProcessJob } from './support/queue-jobs';

// ---- Mocks: the routes get the test database, the boss and SES are fakes ---

const holder = vi.hoisted(() => ({
  db: undefined as Database | undefined,
  boss: undefined as unknown,
}));
const sendEmailMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

// POST /v1/emails queues through the orchestrator's boss. Hand it the test boss.
vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => holder.boss }),
}));

// The mail send itself. The rest of the SES barrel stays real so the erase
// route's SES client is the one the SDK mock below intercepts.
vi.mock('#app/lib/ses/send', () => ({ sendEmail: sendEmailMock }));

const sesMock = mockClient(SESv2Client);
const s3Mock = mockClient(S3Client);

// The scenes seed dozens of rows through a real database, and the whole suite shares
// one Postgres, so the default 5 s is too tight when other files run beside this one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { ERASE_STORES } = await import('#app/lib/recipient-erase');
type EraseStoreName = (typeof ERASE_STORES)[number]['name'];
const { createApiKey } = await import('#app/models/api-keys.server');
const { createEmailSendHandler } = await import('#app/workflows/email-send');
const { resetSesClients } = await import('#app/lib/ses');
const { inboundSenderHash } = await import('#app/lib/inbound/sender-hash');
const { INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE } = await import('#app/lib/queue-names');

const apiLayoutModule = await import('#app/routes/_api');
const eraseRouteModule = await import('#app/routes/api.v1.recipients.erase');
const emailsRouteModule = await import('#app/routes/api.v1.emails');

const handleRequest = createApiHandler({
  modules: {
    'routes/_api.tsx': apiLayoutModule,
    'routes/api.v1.recipients.erase.tsx': eraseRouteModule,
    'routes/api.v1.emails.tsx': emailsRouteModule,
  },
});

// ---- The fixture and its provenance ----------------------------------------

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures/erase-contract');
const FIXTURE_FILE = 'pigeon-erase-request.json';
const PROVENANCE_FILE = 'PROVENANCE';

const EraseFixtureSchema = z.object({
  method: z.string().min(1),
  path: z.string().startsWith('/'),
  headerNames: z.array(z.string().min(1)).min(1),
  secretHeaderNames: z.array(z.string().min(1)),
  headerValues: z.record(z.string(), z.string()),
  body: z.string().min(1),
});
type EraseFixture = z.infer<typeof EraseFixtureSchema>;

function readFixtureBytes(opts: { dir: string }): Buffer {
  const file = join(opts.dir, FIXTURE_FILE);
  // A missing fixture must fail loudly: a contract test with nothing to replay
  // would pass while checking nothing.
  if (!existsSync(file)) throw new Error(`erase contract fixture is missing: ${file}`);
  return readFileSync(file);
}

function parseFixture(bytes: Buffer): EraseFixture {
  return EraseFixtureSchema.parse(JSON.parse(bytes.toString('utf8')));
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const FIXTURE_BYTES = readFixtureBytes({ dir: FIXTURE_DIR });
const FIXTURE = parseFixture(FIXTURE_BYTES);
const FIXTURE_ADDRESS = z.object({ email: z.string().email() }).parse(JSON.parse(FIXTURE.body)).email;
const OTHER_ADDRESS = 'bystander@example.net';

/**
 * Build the request the core sends, from the fixture. Every header the fixture
 * lists is set: a secret one from the key, any other from `headerValues`. A
 * header the fixture lists without a value is an error here, not a skipped line.
 */
function buildRequestFromFixture(opts: { apiKey: string; path?: string }): Request {
  const headers = new Headers();
  for (const name of FIXTURE.headerNames) {
    if (FIXTURE.secretHeaderNames.includes(name)) {
      if (name !== 'authorization') throw new Error(`fixture has a secret header this test cannot mint: ${name}`);
      headers.set(name, `Bearer ${opts.apiKey}`);
      continue;
    }
    const value = FIXTURE.headerValues[name];
    if (value === undefined) throw new Error(`fixture lists header ${name} but gives no value`);
    headers.set(name, value);
  }
  return new Request(new URL(opts.path ?? FIXTURE.path, 'http://pigeon.test'), {
    method: FIXTURE.method,
    headers,
    body: FIXTURE.body,
  });
}

// ---- Database ---------------------------------------------------------------

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ queues: ['email.send', INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE] });
  holder.db = testDb.db;
  holder.boss = testDb.boss;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

beforeEach(() => {
  sesMock.reset();
  sesMock.on(DeleteSuppressedDestinationCommand).resolves({});
  resetSesClients();
  s3Mock.reset();
  s3Mock.on(DeleteObjectCommand).resolves({});
  sendEmailMock.mockReset();
  // message_id is unique in the emails table, so every send gets its own.
  sendEmailMock.mockImplementation(async () => ({ messageId: randomUUID() }));
});

// ---- Seeding every store, keyed by the store's own name ---------------------

type Probe = () => Promise<boolean>;

const SEEDERS: Record<EraseStoreName, (opts: { appId: string; address: string }) => Promise<Probe>> = {
  email_events: async ({ appId, address }) => {
    const emailId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [address] } });
    const eventId = await seedEvent({ db: testDb.db, appId, emailId });
    return async () =>
      (await testDb.db.select({ id: emailEvents.id }).from(emailEvents).where(eq(emailEvents.id, eventId)))
        .length > 0;
  },
  emails: async ({ appId, address }) => {
    const id = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [address] } });
    return async () => (await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).length > 0;
  },
  contacts: async ({ appId, address }) => {
    const id = await seedContact({ db: testDb.db, appId, email: address });
    return async () =>
      (await testDb.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, id))).length > 0;
  },
  suppressions: async ({ appId, address }) => {
    const id = await seedSuppression({ db: testDb.db, appId, email: address, reason: 'hard_bounce' });
    return async () =>
      (await testDb.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.id, id))).length > 0;
  },
  queue_jobs: async ({ appId, address }) => {
    const id = await queueEmailJob({ testDb, appId, to: [address] });
    return () => jobExists({ pool: testDb.pool, id });
  },
  // A reply from the address, after inbound.process: both jobs must go. The
  // probe holds only while both are there, so one job left counts as held.
  inbound_queue_jobs: async ({ appId, address }) => {
    const webhookId = await seedWebhook({ db: testDb.db, appId });
    const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: inboundSenderHash(address) });
    const ids = [
      await queueInboundDeliveryJob({ testDb, appId, webhookId, from: address, inboundEmailId: row.id }),
      await queueInboundProcessJob({ testDb, appId, inboundEmailId: row.id }),
    ];
    return async () => {
      for (const id of ids) {
        if (await jobExists({ pool: testDb.pool, id })) return true;
      }
      return false;
    };
  },
  inbound_emails: async ({ appId, address }) => {
    const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: inboundSenderHash(address) });
    return async () =>
      (await testDb.db.select({ id: inboundEmails.id }).from(inboundEmails).where(eq(inboundEmails.id, row.id)))
        .length > 0;
  },
};

const STORE_NAMES = ERASE_STORES.map((store) => store.name);

type Probes = Record<EraseStoreName, Probe>;

async function seedAllStores(opts: { appId: string; address: string }): Promise<Probes> {
  const probes = {} as Probes;
  for (const name of STORE_NAMES) probes[name] = await SEEDERS[name](opts);
  return probes;
}

/** Names of the stores whose probe still sees its row. */
async function storesStillHolding(probes: Probes): Promise<EraseStoreName[]> {
  const holding: EraseStoreName[] = [];
  for (const name of STORE_NAMES) {
    if (await probes[name]()) holding.push(name);
  }
  return holding;
}

interface Scene {
  appA: string;
  appB: string;
  apiKeyA: string;
  /** The fixture's address in app A, the one the request names. */
  target: Probes;
  /** The same address in app B. */
  otherApp: Probes;
  /** Another address in app A. */
  otherAddress: Probes;
}

async function buildScene(): Promise<Scene> {
  const appA = await seedApp({ db: testDb.db });
  const appB = await seedApp({ db: testDb.db });
  const { plaintext } = await createApiKey({ appId: appA, name: 'contract-test' });
  return {
    appA,
    appB,
    apiKeyA: plaintext,
    target: await seedAllStores({ appId: appA, address: FIXTURE_ADDRESS }),
    otherApp: await seedAllStores({ appId: appB, address: FIXTURE_ADDRESS }),
    otherAddress: await seedAllStores({ appId: appA, address: OTHER_ADDRESS }),
  };
}

// ---- The fixture is the core's, and it is there -----------------------------

describe('the erase contract fixture', () => {
  it('has a store list the seeders cover, and no seeder for a store that is gone', () => {
    expect(Object.keys(SEEDERS).sort()).toEqual([...STORE_NAMES].sort());
  });

  it('is the request the consumer core sends: POST /v1/recipients/erase with a Bearer key and a JSON body', () => {
    expect(FIXTURE.method).toBe('POST');
    expect(FIXTURE.path).toBe('/v1/recipients/erase');
    expect(FIXTURE.headerNames).toEqual(['authorization', 'content-type']);
    expect(FIXTURE.secretHeaderNames).toEqual(['authorization']);
    expect(FIXTURE.headerValues['content-type']).toBe('application/json');
    expect(JSON.parse(FIXTURE.body)).toEqual({ email: 'leaving.person@example.org' });
  });

  it('matches the sha256 recorded in PROVENANCE, so a hand edit of the copy fails', () => {
    const provenance = readFileSync(join(FIXTURE_DIR, PROVENANCE_FILE), 'utf8');
    const recorded = /^sha256: ([0-9a-f]{64})$/m.exec(provenance)?.[1];
    if (!recorded) throw new Error('PROVENANCE has no "sha256: <64 hex>" line');

    expect(sha256Hex(FIXTURE_BYTES)).toBe(recorded);
    // Control: one extra byte must not hash to the recorded value, or this
    // check could never fail.
    expect(sha256Hex(Buffer.concat([FIXTURE_BYTES, Buffer.from(' ')]))).not.toBe(recorded);
  });

  it('names its source path and a full core commit in PROVENANCE', () => {
    const provenance = readFileSync(join(FIXTURE_DIR, PROVENANCE_FILE), 'utf8');

    expect(provenance).toMatch(/^source: apps\/core\/tests\/fixtures\/erase-contract\/pigeon-erase-request\.json/m);
    expect(provenance).toMatch(/^core-commit: [0-9a-f]{40}$/m);
  });

  it('fails when the fixture file is missing', () => {
    const emptyDir = join(tmpdir(), `pigeon-no-such-fixture-${randomUUID()}`);

    expect(() => readFixtureBytes({ dir: emptyDir })).toThrow(/erase contract fixture is missing/);
  });
});

// ---- The replay -------------------------------------------------------------

describe('replaying the core erase request', () => {
  it('seeds a probe that sees every row before the request, so an empty store means erased', async () => {
    const scene = await buildScene();

    expect(await storesStillHolding(scene.target)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherApp)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherAddress)).toEqual(STORE_NAMES);
  });

  it('answers 204, empties every store for the address in app A and spares app B and the other address', async () => {
    const scene = await buildScene();

    const response = await handleRequest(buildRequestFromFixture({ apiKey: scene.apiKeyA }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await storesStillHolding(scene.target)).toEqual([]);
    expect(await storesStillHolding(scene.otherApp)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherAddress)).toEqual(STORE_NAMES);
    // App B still holds a suppression for the address, so the SES entry stays.
    expect(sesMock.commandCalls(DeleteSuppressedDestinationCommand)).toHaveLength(0);
    // The raw mail of app A's two received rows from the address, nothing else.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
  });

  it('deletes the address at SES when no app holds a suppression for it any more', async () => {
    // Earlier scenes left suppressions for this address in other apps, and the
    // read runs across apps.
    await testDb.db.delete(suppressions);
    const appA = await seedApp({ db: testDb.db });
    const { plaintext } = await createApiKey({ appId: appA, name: 'contract-test' });
    await seedAllStores({ appId: appA, address: FIXTURE_ADDRESS });

    const response = await handleRequest(buildRequestFromFixture({ apiKey: plaintext }));

    expect(response.status).toBe(204);
    const sesCalls = sesMock.commandCalls(DeleteSuppressedDestinationCommand);
    expect(sesCalls).toHaveLength(1);
    expect(sesCalls[0]?.args[0].input.EmailAddress).toBe(FIXTURE_ADDRESS);
  });

  // These paths match no route in app/routes.ts, so the real answer is the
  // router's 404 and the erase never runs. If one of them ever becomes a route,
  // this test fails and the path needs replacing. One scene serves every
  // request, because none of them may change a row.
  it('control, fixture path changed: 404 and nothing is erased', async () => {
    const changedPaths = [
      FIXTURE.path.replace('recipients', 'recipient'),
      `${FIXTURE.path}/now`,
      FIXTURE.path.replace('erase', 'delete'),
    ];
    const scene = await buildScene();

    for (const path of changedPaths) {
      expect(path).not.toBe(FIXTURE.path);
      const response = await handleRequest(buildRequestFromFixture({ apiKey: scene.apiKeyA, path }));
      expect(response.status, path).toBe(404);
    }

    expect(await storesStillHolding(scene.target)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherApp)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherAddress)).toEqual(STORE_NAMES);
    expect(sesMock.commandCalls(DeleteSuppressedDestinationCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('control, key that is not an API key: 401 and nothing is erased', async () => {
    const scene = await buildScene();

    const response = await handleRequest(buildRequestFromFixture({ apiKey: `ske_${'0'.repeat(64)}` }));

    expect(response.status).toBe(401);
    expect(await storesStillHolding(scene.target)).toEqual(STORE_NAMES);
    expect(sesMock.commandCalls(DeleteSuppressedDestinationCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('control, the key of app B: erases the address in app B only', async () => {
    const scene = await buildScene();
    const { plaintext: apiKeyB } = await createApiKey({ appId: scene.appB, name: 'contract-test-b' });

    const response = await handleRequest(buildRequestFromFixture({ apiKey: apiKeyB }));

    expect(response.status).toBe(204);
    expect(await storesStillHolding(scene.otherApp)).toEqual([]);
    expect(await storesStillHolding(scene.target)).toEqual(STORE_NAMES);
    expect(await storesStillHolding(scene.otherAddress)).toEqual(STORE_NAMES);
  });
});

// ---- retain_body: false, as the core sends it --------------------------------

// What the consumer core's `postMail` (src/mail/mailer.ts) posts for a letter with
// a secret link: the same fields as any letter, plus `retain_body: false`.
// Already covered in halves elsewhere: app/routes/__tests__/emails-api.test.ts
// proves the schema accepts the field and queues retainBody false (mock
// database, mock boss), and test/email-send-retain-body.test.ts proves a queued
// retainBody false job leaves a blank row (jobs seeded by hand). Nothing joined
// the two, so this runs the body the core sends through the route, the real
// queue and the worker handler.
describe('POST /v1/emails with retain_body: false, as the core sends it', () => {
  const RESET_LINK_HTML = '<p>Reset your password: https://app.example.test/reset?token=sr_secret</p>';
  const RESET_LINK_TEXT = 'Reset your password: https://app.example.test/reset?token=sr_secret';

  // The erase tests above leave email.send jobs behind, and fetch takes the
  // oldest one. Start from an empty queue so the job fetched is this test's.
  beforeEach(async () => {
    await testDb.pool.query(`DELETE FROM pgboss.job WHERE name = 'email.send'`);
  });

  async function sendThroughRoute(opts: { retainBodyFalse: boolean }) {
    const appId = await seedApp({ db: testDb.db });
    const { plaintext } = await createApiKey({ appId, name: 'mail-test' });
    const hostname = `mail-${randomUUID()}.example.test`;
    await testDb.db.insert(domains).values({ appId, name: hostname, dkimStatus: 'verified' });
    const payload = {
      from: `noreply@${hostname}`,
      to: [FIXTURE_ADDRESS],
      subject: 'Reset your password',
      text: RESET_LINK_TEXT,
      html: RESET_LINK_HTML,
      ...(opts.retainBodyFalse ? { retain_body: false } : {}),
    };

    const response = await handleRequest(
      new Request('http://pigeon.test/v1/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(201);
    const { id: emailId } = z.object({ id: z.string() }).parse(await response.json());

    const [queuedRow] = await testDb.db.select().from(emails).where(eq(emails.id, emailId));
    const jobs = await testDb.boss.fetch('email.send', { includeMetadata: true });
    const [job] = jobs;
    if (!job) throw new Error('POST /v1/emails queued no email.send job');
    const handler = createEmailSendHandler(testDb.boss);
    await handler(jobs as unknown as Parameters<typeof handler>[0]);
    await testDb.boss.complete('email.send', job.id);

    const [sentRow] = await testDb.db.select().from(emails).where(eq(emails.id, emailId));
    return { queuedRow, sentRow, jobId: job.id };
  }

  it('is accepted, then leaves a blank body on the row and no job in pg-boss after the send', async () => {
    const { queuedRow, sentRow, jobId } = await sendThroughRoute({ retainBodyFalse: true });

    // Before the send the body is there, so the blank after it is the worker's doing.
    expect(queuedRow?.status).toBe('queued');
    expect(queuedRow?.html).toBe(RESET_LINK_HTML);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sentRow?.status).toBe('sent');
    expect(sentRow?.html).toBeNull();
    expect(sentRow?.text).toBeNull();
    expect(sentRow?.headers).toEqual({});
    expect(sentRow?.toAddresses).toEqual([FIXTURE_ADDRESS]);
    expect(sentRow?.subject).toBe('Reset your password');
    expect(await jobExists({ pool: testDb.pool, id: jobId })).toBe(false);
  });

  it('control, without the field the body and the job stay', async () => {
    const { sentRow, jobId } = await sendThroughRoute({ retainBodyFalse: false });

    expect(sentRow?.status).toBe('sent');
    expect(sentRow?.html).toBe(RESET_LINK_HTML);
    expect(sentRow?.text).toBe(RESET_LINK_TEXT);
    expect(await jobExists({ pool: testDb.pool, id: jobId })).toBe(true);
  });
});
