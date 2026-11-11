/**
 * Recipient erase: the store list, and POST /v1/recipients/erase.
 *
 * Runs against a real throwaway Postgres with pg-boss installed, see
 * test/support/test-database.ts (local: DB_PORT=5433 pnpm test).
 *
 * Every store gets the same three controls: the row of the target address is
 * gone, the row of another address stays, and the row of another app with the
 * same address stays. The fixtures are keyed by store name from ERASE_STORES,
 * so a store without a fixture fails, and a test that leaves one store out of
 * the run proves the fixture can fail.
 *
 * Received mail (inbound) is matched by the keyed sender hash that
 * inbound.process writes. Its raw mail in S3 is deleted before the
 * transaction; S3 is faked here (aws-sdk-client-mock, or a stub passed as
 * deleteRawMail), nothing reaches AWS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteSuppressedDestinationCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { contacts, emailEvents, emails, inboundEmails, suppressions, webhooks } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
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
import {
  archiveJob,
  archivedJobExists,
  jobExists,
  queueEmailJob,
  queueInboundDeliveryJob,
  queueInboundProcessJob,
} from './support/queue-jobs';
import { plainMail } from './support/inbound-fixtures';

// ---- Mocks: the route gets the test database, the logger is captured -------

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));
const logged = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock('#app/lib/logger', () => {
  const capture = (...args: unknown[]) => {
    logged.lines.push(JSON.stringify(args));
  };
  const logger = { info: capture, warn: capture, error: capture, debug: capture };
  return { createComponentLogger: () => logger, logger };
});

const sesMock = mockClient(SESv2Client);
const s3Mock = mockClient(S3Client);

// A scene seeds seven stores three times through a real database (inbound
// mail adds a domain, a webhook and two pg-boss jobs per seed), and the whole
// suite shares one Postgres. The default 5 s timed out in the full parallel
// run, and a timed-out test kept running into the next one and broke its SES
// call count. Same settings as recipient-erase-contract.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { ERASE_STORES, COMPLAINT_REASON, eraseRecipientData, isAddressSuppressedInAnyApp } = await import(
  '#app/lib/recipient-erase'
);
type EraseStoreName = (typeof ERASE_STORES)[number]['name'];
const { action } = await import('#app/routes/api.v1.recipients.erase');
const { resetSesClients } = await import('#app/lib/ses');
const { inboundSenderHash } = await import('#app/lib/inbound/sender-hash');
const { handleInboundProcess } = await import('#app/workflows/inbound-process');
const { INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE } = await import('#app/lib/queue-names');

// ---- Database ---------------------------------------------------------------

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ queues: ['email.send', INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE] });
  holder.db = testDb.db;
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
  logged.lines.length = 0;
});

// ---- Fixtures: one per store, keyed by the store's own name -----------------

const TARGET = 'Target@Example.com'; // mixed case on purpose
const OTHER_ADDRESS = 'bystander@example.com';

/** Seeds one row for `address` in a store and returns a probe: does it still exist? */
type Probe = () => Promise<boolean>;

/**
 * Probe for a store that seeds several jobs: true when all are there, false
 * when none is, and a thrown error for a partial erase, which no assertion
 * on a single boolean could tell apart from success.
 */
async function allOrNoJobs(opts: { store: string; ids: readonly string[] }): Promise<boolean> {
  const present: boolean[] = [];
  for (const id of opts.ids) present.push(await jobExists({ pool: testDb.pool, id }));
  if (present.every(Boolean)) return true;
  if (!present.some(Boolean)) return false;
  throw new Error(`${opts.store}: partial erase, ${present.filter(Boolean).length} of ${opts.ids.length} jobs left`);
}

async function inboundRowExists(id: string): Promise<boolean> {
  const rows = await testDb.db.select({ id: inboundEmails.id }).from(inboundEmails).where(eq(inboundEmails.id, id));
  return rows.length > 0;
}

/**
 * One received mail from `address` to an app, as it stands after
 * inbound.process: the row with the sender hash, an email.received delivery
 * job for the app's webhook and the inbound.process job (still in the table
 * while pg-boss keeps it).
 */
async function seedReceivedMail(opts: { appId: string; address: string }) {
  const { appId, address } = opts;
  const webhookId = await seedWebhook({ db: testDb.db, appId });
  const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: inboundSenderHash(address) });
  const deliveryJob = await queueInboundDeliveryJob({ testDb, appId, webhookId, from: address, inboundEmailId: row.id });
  const processJob = await queueInboundProcessJob({ testDb, appId, inboundEmailId: row.id });
  return { webhookId, row, deliveryJob, processJob };
}

interface StoreFixture {
  seed(opts: { appId: string; address: string }): Promise<Probe>;
}

const FIXTURES: Record<EraseStoreName, StoreFixture> = {
  email_events: {
    async seed({ appId, address }) {
      const emailId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [address] } });
      const eventId = await seedEvent({ db: testDb.db, appId, emailId });
      return async () =>
        (await testDb.db.select({ id: emailEvents.id }).from(emailEvents).where(eq(emailEvents.id, eventId)))
          .length > 0;
    },
  },
  emails: {
    async seed({ appId, address }) {
      const id = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [address] } });
      return async () => (await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).length > 0;
    },
  },
  contacts: {
    async seed({ appId, address }) {
      const id = await seedContact({ db: testDb.db, appId, email: address });
      return async () =>
        (await testDb.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, id))).length > 0;
    },
  },
  suppressions: {
    async seed({ appId, address }) {
      const id = await seedSuppression({ db: testDb.db, appId, email: address, reason: 'hard_bounce' });
      return async () =>
        (await testDb.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.id, id)))
          .length > 0;
    },
  },
  queue_jobs: {
    async seed({ appId, address }) {
      const id = await queueEmailJob({ testDb, appId, to: [address] });
      return () => jobExists({ pool: testDb.pool, id });
    },
  },
  inbound_queue_jobs: {
    async seed({ appId, address }) {
      const mail = await seedReceivedMail({ appId, address });
      return () => allOrNoJobs({ store: 'inbound_queue_jobs', ids: [mail.deliveryJob, mail.processJob] });
    },
  },
  inbound_emails: {
    async seed({ appId, address }) {
      const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: inboundSenderHash(address) });
      return () => inboundRowExists(row.id);
    },
  },
};

const STORE_NAMES = ERASE_STORES.map((store) => store.name);

interface Scene {
  appId: string;
  otherAppId: string;
  target: Record<EraseStoreName, Probe>;
  otherAddress: Record<EraseStoreName, Probe>;
  otherApp: Record<EraseStoreName, Probe>;
}

/** Three rows per store: the target, another address, the target in another app. */
async function buildScene(): Promise<Scene> {
  const appId = await seedApp({ db: testDb.db });
  const otherAppId = await seedApp({ db: testDb.db });
  const scene = { appId, otherAppId, target: {}, otherAddress: {}, otherApp: {} } as Scene;
  for (const name of STORE_NAMES) {
    const fixture = FIXTURES[name];
    scene.target[name] = await fixture.seed({ appId, address: TARGET });
    scene.otherAddress[name] = await fixture.seed({ appId, address: OTHER_ADDRESS });
    scene.otherApp[name] = await fixture.seed({ appId: otherAppId, address: TARGET });
  }
  return scene;
}

// ---- The store list ---------------------------------------------------------

describe('erase store list', () => {
  it('has a fixture for every store and no fixture for a store that is gone', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...STORE_NAMES].sort());
  });

  it('seeds a probe that sees every fixture row before the erase', async () => {
    const scene = await buildScene();
    for (const name of STORE_NAMES) {
      expect(await scene.target[name]()).toBe(true);
      expect(await scene.otherAddress[name]()).toBe(true);
      expect(await scene.otherApp[name]()).toBe(true);
    }
  });

  it.each(STORE_NAMES)('%s: erases the address, spares another address and another app', async (name) => {
    const scene = await buildScene();

    await eraseRecipientData({ db: testDb.db, appId: scene.appId, email: TARGET });

    expect(await scene.target[name]()).toBe(false);
    expect(await scene.otherAddress[name]()).toBe(true);
    expect(await scene.otherApp[name]()).toBe(true);
  });

  it.each(STORE_NAMES)(
    '%s: a run that leaves this store out leaves its row behind, and only its row',
    async (name) => {
      const scene = await buildScene();
      const withoutStore = ERASE_STORES.filter((store) => store.name !== name);

      await eraseRecipientData({ db: testDb.db, appId: scene.appId, email: TARGET, stores: withoutStore });

      // The probe for the omitted store must see its row: this is the control
      // that proves the per-store check can fail.
      expect(await scene.target[name]()).toBe(true);
      for (const other of STORE_NAMES.filter((n) => n !== name)) {
        expect(await scene.target[other]()).toBe(false);
      }
    },
  );
});

// ---- Matching rules ---------------------------------------------------------

describe('which emails match', () => {
  it.each(['toAddresses', 'ccAddresses', 'bccAddresses'] as const)(
    'deletes an email that holds the address in %s, case insensitive',
    async (column) => {
      const appId = await seedApp({ db: testDb.db });
      const id = await seedEmail({
        db: testDb.db,
        appId,
        overrides: { toAddresses: ['first@example.com'], [column]: ['x@example.com', 'TARGET@EXAMPLE.COM'] },
      });

      await eraseRecipientData({ db: testDb.db, appId, email: 'target@example.com' });

      expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).toHaveLength(0);
    },
  );

  it('deletes an email whose reply_to is the address', async () => {
    const appId = await seedApp({ db: testDb.db });
    const id = await seedEmail({ db: testDb.db, appId, overrides: { replyTo: 'Target@example.com' } });

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).toHaveLength(0);
  });

  it('deletes a multi recipient row whole', async () => {
    const appId = await seedApp({ db: testDb.db });
    const id = await seedEmail({
      db: testDb.db,
      appId,
      overrides: { toAddresses: [TARGET, OTHER_ADDRESS] },
    });

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).toHaveLength(0);
  });

  it('does not match an address that only contains the target as a substring', async () => {
    const appId = await seedApp({ db: testDb.db });
    const id = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: ['not-target@example.com'] } });

    await eraseRecipientData({ db: testDb.db, appId, email: 'target@example.com' });

    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, id))).toHaveLength(1);
  });
});

describe('queue jobs', () => {
  it.each(['cc', 'bcc'] as const)('deletes an email.send job that carries the address in %s', async (key) => {
    const appId = await seedApp({ db: testDb.db });
    const id = await queueEmailJob({ testDb, appId, to: ['first@example.com'], [key]: [TARGET] });

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    expect(await jobExists({ pool: testDb.pool, id })).toBe(false);
  });

  it('deletes an email.send job whose replyTo is the address', async () => {
    const appId = await seedApp({ db: testDb.db });
    const id = await queueEmailJob({ testDb, appId, to: ['first@example.com'], replyTo: TARGET });

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    expect(await jobExists({ pool: testDb.pool, id })).toBe(false);
  });

  it('deletes a finished job that pg-boss already moved to the archive table', async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    const mine = await queueEmailJob({ testDb, appId, to: [TARGET] });
    const bystander = await queueEmailJob({ testDb, appId, to: [OTHER_ADDRESS] });
    const otherApp = await queueEmailJob({ testDb, appId: otherAppId, to: [TARGET] });
    for (const id of [mine, bystander, otherApp]) await archiveJob({ pool: testDb.pool, id });
    expect(await archivedJobExists({ pool: testDb.pool, id: mine })).toBe(true);

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    expect(await archivedJobExists({ pool: testDb.pool, id: mine })).toBe(false);
    expect(await archivedJobExists({ pool: testDb.pool, id: bystander })).toBe(true);
    expect(await archivedJobExists({ pool: testDb.pool, id: otherApp })).toBe(true);
  });
});

describe('suppressions', () => {
  it('keeps a complaint suppression, so the address keeps being blocked', async () => {
    const appId = await seedApp({ db: testDb.db });
    const id = await seedSuppression({ db: testDb.db, appId, email: TARGET, reason: COMPLAINT_REASON });

    await eraseRecipientData({ db: testDb.db, appId, email: TARGET });

    const rows = await testDb.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.id, id));
    expect(rows).toHaveLength(1);
  });
});

describe('idempotence', () => {
  it('a second erase changes nothing and does not throw', async () => {
    const scene = await buildScene();

    const first = await eraseRecipientData({ db: testDb.db, appId: scene.appId, email: TARGET });
    const second = await eraseRecipientData({ db: testDb.db, appId: scene.appId, email: TARGET });

    expect(Object.values(first).some((count) => count > 0)).toBe(true);
    expect(Object.values(second).every((count) => count === 0)).toBe(true);
  });
});

// ---- The route --------------------------------------------------------------

function callRoute(opts: { appId: string; body?: unknown; rawBody?: string; method?: string }) {
  const request = new Request('http://localhost/v1/recipients/erase', {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: opts.rawBody ?? JSON.stringify(opts.body),
  });
  const context = { get: () => ({ appId: opts.appId, apiKeyId: 'key-test', rateLimitPerSecond: 10 }) };
  return action({ request, context, params: {} } as unknown as Parameters<typeof action>[0]);
}

/** The suppressions table is read across apps, so rows left by an earlier test would count. */
async function clearSuppressions(): Promise<void> {
  await testDb.db.delete(suppressions);
}

async function suppressionExists(id: string): Promise<boolean> {
  const rows = await testDb.db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.id, id));
  return rows.length > 0;
}

function sesCallCount(): number {
  return sesMock.commandCalls(DeleteSuppressedDestinationCommand).length;
}

describe('POST /v1/recipients/erase', () => {
  beforeEach(clearSuppressions);

  it('answers 204, erases the address in the key app and spares the other app', async () => {
    const scene = await buildScene();

    const response = await callRoute({ appId: scene.appId, body: { email: TARGET } });

    expect(response.status).toBe(204);
    for (const name of STORE_NAMES) {
      expect(await scene.target[name]()).toBe(false);
      expect(await scene.otherApp[name]()).toBe(true);
    }
  });

  it('answers 204 for an address that was never a recipient, and again on a second call', async () => {
    const appId = await seedApp({ db: testDb.db });

    const first = await callRoute({ appId, body: { email: 'nobody@example.com' } });
    const second = await callRoute({ appId, body: { email: 'nobody@example.com' } });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('counts a SES NotFoundException as success', async () => {
    sesMock.reset();
    sesMock
      .on(DeleteSuppressedDestinationCommand)
      .rejects(Object.assign(new Error('not on the list'), { name: 'NotFoundException' }));
    const appId = await seedApp({ db: testDb.db });

    const response = await callRoute({ appId, body: { email: TARGET } });

    expect(response.status).toBe(204);
    expect(sesCallCount()).toBe(1);
    expect(logged.lines.join('\n')).not.toContain('SES suppression delete failed');
    expect(logged.lines.join('\n')).toContain('"sesOutcome":"not_found"');
  });

  it('answers 204 when SES fails otherwise, still erases, and logs name and code but no address', async () => {
    sesMock.reset();
    sesMock
      .on(DeleteSuppressedDestinationCommand)
      .rejects(Object.assign(new Error(`throttled ${TARGET}`), { name: 'TooManyRequestsException', Code: 'Throttling' }));
    const appId = await seedApp({ db: testDb.db });
    const emailId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [TARGET] } });

    const response = await callRoute({ appId, body: { email: TARGET } });

    expect(response.status).toBe(204);
    expect(sesCallCount()).toBe(1);
    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, emailId))).toHaveLength(0);
    const output = logged.lines.join('\n');
    expect(output).toContain('TooManyRequestsException');
    expect(output).toContain('Throttling');
    expect(output.toLowerCase()).not.toContain('target@example.com');
  });

  it('never writes the address to a log line on the success path', async () => {
    const scene = await buildScene();

    await callRoute({ appId: scene.appId, body: { email: TARGET } });

    expect(logged.lines.length).toBeGreaterThan(0); // control: the capture works
    expect(logged.lines.join('\n').toLowerCase()).not.toContain('target@example.com');
  });

  it.each([
    ['no body', { rawBody: '' }],
    ['invalid JSON', { rawBody: '{nope' }],
    ['missing email', { body: {} }],
    ['not an address', { body: { email: 'not-an-address' } }],
    ['email as a number', { body: { email: 42 } }],
  ])('answers 400 for %s and touches nothing', async (_label, input) => {
    const scene = await buildScene();

    const response = await callRoute({ appId: scene.appId, ...input });

    expect(response.status).toBe(400);
    expect(await scene.target.emails()).toBe(true);
    expect(sesMock.commandCalls(DeleteSuppressedDestinationCommand)).toHaveLength(0);
  });

  it('answers 405 for a method other than POST', async () => {
    const response = await callRoute({ appId: 'any', rawBody: undefined, method: 'DELETE' });

    expect(response.status).toBe(405);
  });
});

// ---- The shared SES list: erase-suppression-decision -------------------------

describe('isAddressSuppressedInAnyApp', () => {
  beforeEach(clearSuppressions);

  it('sees a row of any app in any case, and no row for another address', async () => {
    const appId = await seedApp({ db: testDb.db });
    await seedSuppression({ db: testDb.db, appId, email: 'HELD@Example.com', reason: 'hard_bounce' });

    expect(await isAddressSuppressedInAnyApp({ db: testDb.db, email: 'held@example.COM' })).toBe(true);
    expect(await isAddressSuppressedInAnyApp({ db: testDb.db, email: 'not-held@example.com' })).toBe(false);
  });
});

describe('POST /v1/recipients/erase and the shared SES suppression list', () => {
  beforeEach(clearSuppressions);

  async function eraseAndExpectBlank204(opts: { appId: string; email: string }): Promise<void> {
    const response = await callRoute({ appId: opts.appId, body: { email: opts.email } });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  }

  it('an erase keeps the SES entry while another app holds a suppression', async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    const otherRow = await seedSuppression({ db: testDb.db, appId: otherAppId, email: TARGET, reason: 'hard_bounce' });

    await eraseAndExpectBlank204({ appId, email: TARGET });

    expect(sesCallCount()).toBe(0);
    expect(await suppressionExists(otherRow)).toBe(true);
    expect(logged.lines.join('\n')).toContain('"sesOutcome":"kept"');
  });

  it("an erase keeps the SES entry for the app's own complaint", async () => {
    const appId = await seedApp({ db: testDb.db });
    const ownRow = await seedSuppression({ db: testDb.db, appId, email: TARGET, reason: 'complaint' });

    await eraseAndExpectBlank204({ appId, email: TARGET });

    expect(sesCallCount()).toBe(0);
    expect(await suppressionExists(ownRow)).toBe(true);
    expect(logged.lines.join('\n')).toContain('"sesOutcome":"kept"');
  });

  it('an erase deletes the SES entry when no suppression remains', async () => {
    const appId = await seedApp({ db: testDb.db });
    const ownRow = await seedSuppression({ db: testDb.db, appId, email: TARGET, reason: 'hard_bounce' });

    await eraseAndExpectBlank204({ appId, email: TARGET });

    const sesCalls = sesMock.commandCalls(DeleteSuppressedDestinationCommand);
    expect(sesCalls).toHaveLength(1);
    expect(sesCalls[0]?.args[0].input.EmailAddress).toBe('target@example.com');
    expect(await suppressionExists(ownRow)).toBe(false);
    const output = logged.lines.join('\n');
    expect(output).toContain('"sesOutcome":"deleted"');
    expect(output.toLowerCase()).not.toContain('target@example.com');
  });

  it.each([
    ['stored in upper case, erased in lower case', 'TARGET@EXAMPLE.COM', 'target@example.com'],
    ['stored in lower case, erased in mixed case', 'target@example.com', 'TaRgEt@Example.COM'],
  ])('counts a row of another case: %s', async (_label, stored, erased) => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    await seedSuppression({ db: testDb.db, appId: otherAppId, email: stored, reason: 'complaint' });

    await eraseAndExpectBlank204({ appId, email: erased });

    expect(sesCallCount()).toBe(0);
  });

  it('control: another app holding a different address does not keep the SES entry', async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    await seedSuppression({ db: testDb.db, appId: otherAppId, email: `not-${TARGET}`, reason: 'hard_bounce' });

    await eraseAndExpectBlank204({ appId, email: TARGET });

    expect(sesCallCount()).toBe(1);
  });

  it('removes the SES entry when the last app holding the address erases', async () => {
    const firstAppId = await seedApp({ db: testDb.db });
    const lastAppId = await seedApp({ db: testDb.db });
    await seedSuppression({ db: testDb.db, appId: firstAppId, email: TARGET, reason: 'hard_bounce' });
    await seedSuppression({ db: testDb.db, appId: lastAppId, email: TARGET, reason: 'hard_bounce' });

    await eraseAndExpectBlank204({ appId: firstAppId, email: TARGET });
    expect(sesCallCount()).toBe(0);

    await eraseAndExpectBlank204({ appId: lastAppId, email: TARGET });
    expect(sesCallCount()).toBe(1);
  });

  it('an erase keeps the SES entry when the check fails and still answers 204', async () => {
    const appId = await seedApp({ db: testDb.db });
    const emailId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [TARGET] } });
    const readFailure = Object.assign(new Error(`read failed for ${TARGET}`), { name: 'ConnectionLostError' });
    // The stores read through the transaction handle, so two reads go through
    // `db.select`: first the erase's lookup of raw inbound mail (passed
    // through), then the route's suppression read (fails). The call count
    // proves the failing read ran here.
    const realSelect = testDb.db.select.bind(testDb.db) as typeof testDb.db.select;
    const selectSpy = vi
      .spyOn(testDb.db, 'select')
      .mockImplementationOnce(realSelect)
      .mockImplementationOnce(() => {
        throw readFailure;
      });

    let selectCalls: number;
    try {
      await eraseAndExpectBlank204({ appId, email: TARGET });
    } finally {
      // Restore before any assertion: an unused queued failure would leak into
      // the next test. mockRestore also clears the call list, so count first.
      selectCalls = selectSpy.mock.calls.length;
      selectSpy.mockRestore();
    }

    expect(selectCalls).toBe(2);
    expect(sesCallCount()).toBe(0);
    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, emailId))).toHaveLength(0);
    const output = logged.lines.join('\n');
    expect(output).toContain('ConnectionLostError');
    expect(output).toContain('"sesOutcome":"failed"');
    expect(output.toLowerCase()).not.toContain('target@example.com');
    expect(output).not.toContain('read failed for');
  });
});

// ---- Received mail (inbound): the sender is the data subject -----------------

const SENDER = 'Replying.Person@Example.com'; // mixed case on purpose
const OTHER_SENDER = 'another.sender@example.com';

/** A stub for the S3 delete that records each call. */
function recordingDelete() {
  const calls: Array<{ bucket: string; key: string }> = [];
  return {
    calls,
    deleteRawMail: async (object: { bucket: string; key: string }) => {
      calls.push(object);
    },
  };
}

type ReceivedMail = Awaited<ReturnType<typeof seedReceivedMail>>;

async function receivedMailLeft(mail: ReceivedMail): Promise<{ row: boolean; delivery: boolean; process: boolean }> {
  return {
    row: await inboundRowExists(mail.row.id),
    delivery: await jobExists({ pool: testDb.pool, id: mail.deliveryJob }),
    process: await jobExists({ pool: testDb.pool, id: mail.processJob }),
  };
}

const ALL_LEFT = { row: true, delivery: true, process: true };
const NONE_LEFT = { row: false, delivery: false, process: false };

describe('received mail from the address', () => {
  it("erases the sender's row, its S3 object and both inbound jobs, and spares another sender and another app", async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    const target = await seedReceivedMail({ appId, address: SENDER });
    const otherSender = await seedReceivedMail({ appId, address: OTHER_SENDER });
    const otherApp = await seedReceivedMail({ appId: otherAppId, address: SENDER });
    const s3 = recordingDelete();

    const counts = await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: s3.deleteRawMail });

    expect(await receivedMailLeft(target)).toEqual(NONE_LEFT);
    expect(s3.calls).toEqual([{ bucket: target.row.s3Bucket, key: target.row.s3Key }]);
    expect(await receivedMailLeft(otherSender)).toEqual(ALL_LEFT);
    expect(await receivedMailLeft(otherApp)).toEqual(ALL_LEFT);
    expect(counts).toMatchObject({ inbound_raw_mail: 1, inbound_emails: 1, inbound_queue_jobs: 2 });
  });

  it('makes no S3 call when the app holds no mail from the address', async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    // Data that a wrong match would reach: another sender here, the sender elsewhere.
    await seedReceivedMail({ appId, address: OTHER_SENDER });
    await seedReceivedMail({ appId: otherAppId, address: SENDER });
    const s3 = recordingDelete();

    const counts = await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: s3.deleteRawMail });

    expect(s3.calls).toEqual([]);
    expect(counts.inbound_raw_mail).toBe(0);
  });

  it('throws when S3 fails and deletes nothing in the database', async () => {
    const appId = await seedApp({ db: testDb.db });
    const mail = await seedReceivedMail({ appId, address: SENDER });
    const outboundId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [SENDER] } });
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });

    await expect(
      eraseRecipientData({
        db: testDb.db,
        appId,
        email: SENDER,
        deleteRawMail: async () => Promise.reject(denied),
      }),
    ).rejects.toThrow('Access Denied');

    expect(await receivedMailLeft(mail)).toEqual(ALL_LEFT);
    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, outboundId))).toHaveLength(1);
  });

  it('a retry after an S3 failure erases everything', async () => {
    const appId = await seedApp({ db: testDb.db });
    const mail = await seedReceivedMail({ appId, address: SENDER });
    await expect(
      eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: async () => Promise.reject(new Error('x')) }),
    ).rejects.toThrow();
    const s3 = recordingDelete();

    await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: s3.deleteRawMail });

    expect(await receivedMailLeft(mail)).toEqual(NONE_LEFT);
    expect(s3.calls).toHaveLength(1);
  });

  it('deletes finished inbound jobs that pg-boss moved to the archive table', async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    const target = await seedReceivedMail({ appId, address: SENDER });
    const otherApp = await seedReceivedMail({ appId: otherAppId, address: SENDER });
    const jobs = [target.deliveryJob, target.processJob, otherApp.deliveryJob, otherApp.processJob];
    for (const id of jobs) await archiveJob({ pool: testDb.pool, id });

    await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: recordingDelete().deleteRawMail });

    expect(await archivedJobExists({ pool: testDb.pool, id: target.deliveryJob })).toBe(false);
    expect(await archivedJobExists({ pool: testDb.pool, id: target.processJob })).toBe(false);
    expect(await archivedJobExists({ pool: testDb.pool, id: otherApp.deliveryJob })).toBe(true);
    expect(await archivedJobExists({ pool: testDb.pool, id: otherApp.processJob })).toBe(true);
  });

  it('deletes a delivery job whose webhook was deleted, through the payload organization_id', async () => {
    const appId = await seedApp({ db: testDb.db });
    const mail = await seedReceivedMail({ appId, address: SENDER });
    await testDb.db.delete(webhooks).where(eq(webhooks.id, mail.webhookId));

    await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: recordingDelete().deleteRawMail });

    expect(await jobExists({ pool: testDb.pool, id: mail.deliveryJob })).toBe(false);
  });

  it('stated limit: a row not yet processed (no sender hash) is not matched', async () => {
    const appId = await seedApp({ db: testDb.db });
    const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: null });
    const s3 = recordingDelete();

    await eraseRecipientData({ db: testDb.db, appId, email: SENDER, deleteRawMail: s3.deleteRawMail });

    expect(await inboundRowExists(row.id)).toBe(true);
    expect(s3.calls).toEqual([]);
  });

  it('a mail inbound.process handled with a display-name From is erased by the bare address', async () => {
    const appId = await seedApp({ db: testDb.db });
    await seedWebhook({ db: testDb.db, appId });
    const row = await seedInboundEmail({ db: testDb.db, appId, senderHash: null });
    const raw = plainMail('reply body', { From: '"Jane Doe" <Jane.Doe@Example.COM>' });

    const outcome = await handleInboundProcess({
      data: { inboundEmailId: row.id, appId },
      deps: {
        boss: testDb.boss,
        db: testDb.db,
        openObject: async () => ({ body: Readable.from([raw]), contentLength: raw.length }),
      },
    });
    expect(outcome).toBe('processed');
    const [stored] = await testDb.db
      .select({ senderHash: inboundEmails.senderHash })
      .from(inboundEmails)
      .where(eq(inboundEmails.id, row.id));
    expect(stored?.senderHash).toBe(inboundSenderHash('jane.doe@example.com'));
    const { rows: deliveries } = await testDb.pool.query<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = $1 AND data->'payload'->>'email_id' = $2`,
      [WEBHOOK_DELIVER_INBOUND_QUEUE, row.id],
    );
    expect(deliveries).toHaveLength(1);
    const s3 = recordingDelete();

    await eraseRecipientData({ db: testDb.db, appId, email: 'jane.doe@example.com', deleteRawMail: s3.deleteRawMail });

    expect(await inboundRowExists(row.id)).toBe(false);
    expect(await jobExists({ pool: testDb.pool, id: deliveries[0]!.id })).toBe(false);
    expect(s3.calls).toEqual([{ bucket: row.s3Bucket, key: row.s3Key }]);
  });
});

describe('POST /v1/recipients/erase and received mail', () => {
  beforeEach(clearSuppressions);

  it("answers 204 and deletes the sender's raw mail in S3, and no other key", async () => {
    const appId = await seedApp({ db: testDb.db });
    const otherAppId = await seedApp({ db: testDb.db });
    const target = await seedReceivedMail({ appId, address: SENDER });
    await seedReceivedMail({ appId, address: OTHER_SENDER });
    await seedReceivedMail({ appId: otherAppId, address: SENDER });

    const response = await callRoute({ appId, body: { email: SENDER } });

    expect(response.status).toBe(204);
    const s3Calls = s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input);
    expect(s3Calls).toEqual([{ Bucket: target.row.s3Bucket, Key: target.row.s3Key }]);
    expect(await receivedMailLeft(target)).toEqual(NONE_LEFT);
    expect(logged.lines.join('\n').toLowerCase()).not.toContain(SENDER.toLowerCase());
  });

  it('answers 500 when the S3 delete fails, and the inbound row, the jobs and every other store stay', async () => {
    s3Mock.reset();
    s3Mock
      .on(DeleteObjectCommand)
      .rejects(Object.assign(new Error(`Access Denied for ${SENDER}`), { name: 'AccessDenied' }));
    const appId = await seedApp({ db: testDb.db });
    const mail = await seedReceivedMail({ appId, address: SENDER });
    const outboundId = await seedEmail({ db: testDb.db, appId, overrides: { toAddresses: [SENDER] } });

    const response = await callRoute({ appId, body: { email: SENDER } });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(await receivedMailLeft(mail)).toEqual(ALL_LEFT);
    expect(await testDb.db.select({ id: emails.id }).from(emails).where(eq(emails.id, outboundId))).toHaveLength(1);
    expect(sesCallCount()).toBe(0);
    const output = logged.lines.join('\n');
    expect(output).toContain('AccessDenied');
    expect(output.toLowerCase()).not.toContain(SENDER.toLowerCase());
  });
});
