/**
 * Inbound mail against a real throwaway Postgres with pg-boss 10 installed
 * (local: DB_PORT=5433 pnpm test): model scoping, the SNS duplicate guard on
 * the real unique index, app scoping of the fan-out, and the retention pass.
 */
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { archiveJob, archivedJobExists, finishJob, jobExists } from './support/queue-jobs';
import { daysAgo } from './support/seed';
import { notificationBody, plainMail, receiptNotification, SAMPLE, SNS_PUBLIC_KEY_PEM, TOPIC_ARN } from './support/inbound-fixtures';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

const { INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE, WEBHOOK_DELIVER_QUEUE } = await import('#app/lib/queue-names');
const inboundDomains = await import('#app/models/inbound-domains.server');
const inboundEmails = await import('#app/models/inbound-emails.server');
const { handleInboundSnsRequest } = await import('#app/lib/inbound/sns-inbound');
const { verifySnsMessage, resetSnsCertCache } = await import('#app/lib/sns/verifier');
const { handleInboundProcess } = await import('#app/workflows/inbound-process');
const { applyInboundRetention } = await import('#app/lib/inbound/retention');
const { webhooks } = await import('#drizzle/schema/index');

let testDb: TestDatabase;
const APP_A = 'app_inbound_a';
const APP_B = 'app_inbound_b';

beforeAll(async () => {
  testDb = await createTestDatabase({ queues: [INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE, WEBHOOK_DELIVER_QUEUE] });
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

async function seedEmail(opts: { appId: string; domainId: string; sesMessageId: string }) {
  const row = await inboundEmails.insertInboundEmail({
    db: testDb.db,
    values: {
      appId: opts.appId,
      inboundDomainId: opts.domainId,
      sesMessageId: opts.sesMessageId,
      s3Bucket: 'example-pigeon-inbound',
      s3Key: `incoming/test/${opts.sesMessageId}`,
      receivedAt: new Date('2026-11-09T10:00:00Z'),
      recipientCount: 1,
      recipients: [SAMPLE.recipient],
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' },
    },
  });
  if (!row) throw new Error('seedEmail: insert returned no row');
  return row;
}

async function jobsOf(queue: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const { rows } = await testDb.pool.query('SELECT id, data FROM pgboss.job WHERE name = $1', [queue]);
  return rows;
}

describe('inbound models', () => {
  it('stores domains lower case, unique across apps, and lists them per app', async () => {
    await inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_A, name: 'models.example.test' });
    await expect(
      inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_B, name: 'models.example.test' }),
    ).rejects.toThrow();
    expect((await inboundDomains.listInboundDomains({ db: testDb.db, appId: APP_A })).map((d) => d.name)).toContain(
      'models.example.test',
    );
    expect(await inboundDomains.listInboundDomains({ db: testDb.db, appId: APP_B })).toEqual([]);
  });

  it('getInboundEmail and listInboundEmails never cross apps', async () => {
    const domain = await inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_A, name: 'scope.example.test' });
    const row = await seedEmail({ appId: APP_A, domainId: domain.id, sesMessageId: 'scope-1' });
    expect(await inboundEmails.getInboundEmail({ db: testDb.db, appId: APP_B, id: row.id })).toBeNull();
    expect((await inboundEmails.getInboundEmail({ db: testDb.db, appId: APP_A, id: row.id }))?.id).toBe(row.id);
    expect(await inboundEmails.listInboundEmails({ db: testDb.db, appId: APP_B, limit: 10 })).toEqual([]);
    const listed = await inboundEmails.listInboundEmails({ db: testDb.db, appId: APP_A, limit: 10 });
    expect(Object.keys(listed[0]!).sort()).toEqual(['createdAt', 'id', 'inboundDomainId', 'receivedAt', 'recipientCount']);
  });
});

describe('inbound route on the real unique index', () => {
  it('a duplicate SNS delivery inserts one row and queues one inbound.process job', async () => {
    resetSnsCertCache();
    await inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_A, name: 'reply.example.test' });
    const deps = {
      topicArn: TOPIC_ARN,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      verify: (envelope: Parameters<typeof verifySnsMessage>[0]) =>
        verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM }),
      confirmSubscription: async () => true,
      findDomains: (names: string[]) => inboundDomains.findEnabledInboundDomainsByNames({ db: testDb.db, names }),
      insertEmail: (values: Parameters<typeof inboundEmails.insertInboundEmail>[0]['values']) =>
        inboundEmails.insertInboundEmail({ db: testDb.db, values }),
      deleteEmail: (opts: { appId: string; id: string }) => inboundEmails.deleteInboundEmail({ db: testDb.db, ...opts }),
      enqueue: async (payload: { inboundEmailId: string; appId: string }) => {
        await testDb.boss.send(INBOUND_PROCESS_QUEUE, payload);
      },
    };
    const notification = receiptNotification({ messageId: 'dup-ses-1' });

    for (const snsId of ['sns-1', 'sns-2', 'sns-3']) {
      const res = await handleInboundSnsRequest({ rawBody: notificationBody(notification, { messageId: snsId }), deps });
      expect(res.status).toBe(200);
    }

    const { rows } = await testDb.pool.query('SELECT id FROM inbound_emails WHERE ses_message_id = $1', ['dup-ses-1']);
    expect(rows).toHaveLength(1);
    const jobs = await jobsOf(INBOUND_PROCESS_QUEUE);
    expect(jobs.filter((job) => job.data.inboundEmailId === rows[0].id)).toHaveLength(1);
    expect(Object.keys(jobs[0]!.data).sort()).toEqual(['appId', 'inboundEmailId']);
  });
});

describe('fan-out scoping', () => {
  it("only the owning app's enabled hooks with email.received or * get a delivery", async () => {
    const domain = await inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_A, name: 'fanout.example.test' });
    const row = await seedEmail({ appId: APP_A, domainId: domain.id, sesMessageId: 'fanout-1' });

    const insert = async (appId: string, url: string, eventTypes: string[], enabled = true) => {
      const [hook] = await testDb.db
        .insert(webhooks)
        .values({ appId, url, signingSecret: 's', eventTypes, enabled })
        .returning();
      return hook!.id;
    };
    const received = await insert(APP_A, 'https://a.example.com/received', ['email.received']);
    const all = await insert(APP_A, 'https://a.example.com/all', ['*']);
    await insert(APP_A, 'https://a.example.com/bounces', ['email.bounced']);
    await insert(APP_A, 'https://a.example.com/disabled', ['*'], false);
    await insert(APP_B, 'https://b.example.com/all', ['*']);
    await insert(APP_B, 'https://b.example.com/received', ['email.received']);

    const raw = plainMail();
    const outcome = await handleInboundProcess({
      data: { inboundEmailId: row.id, appId: APP_A },
      deps: {
        boss: testDb.boss,
        db: testDb.db,
        openObject: async () => ({ body: Readable.from([raw]), contentLength: raw.length }),
      },
    });
    expect(outcome).toBe('processed');

    const jobs = await jobsOf(WEBHOOK_DELIVER_INBOUND_QUEUE);
    const forRow = jobs.filter((job) => (job.data.payload as { email_id: string }).email_id === row.id);
    expect(forRow.map((job) => job.data.webhookId).sort()).toEqual([all, received].sort());
    expect(await jobsOf(WEBHOOK_DELIVER_QUEUE)).toEqual([]);
  });
});

describe('inbound retention', () => {
  it('deletes inbound_emails rows near 7 days and keeps fresh ones', async () => {
    const domain = await inboundDomains.createInboundDomain({ db: testDb.db, appId: APP_A, name: 'retention.example.test' });
    const old = await seedEmail({ appId: APP_A, domainId: domain.id, sesMessageId: 'ret-old' });
    const fresh = await seedEmail({ appId: APP_A, domainId: domain.id, sesMessageId: 'ret-fresh' });
    await testDb.pool.query('UPDATE inbound_emails SET created_at = $2 WHERE id = $1', [old.id, daysAgo(7)]);

    const result = await applyInboundRetention({ db: testDb.db });
    expect(result.inboundEmailsDeleted).toBeGreaterThanOrEqual(1);
    expect(await inboundEmails.getInboundEmail({ db: testDb.db, appId: APP_A, id: old.id })).toBeNull();
    expect(await inboundEmails.getInboundEmail({ db: testDb.db, appId: APP_A, id: fresh.id })).not.toBeNull();
  });

  it('prunes inbound queue jobs by state and age and leaves other queues alone', async () => {
    const send = async (queue: string) => {
      const id = await testDb.boss.send(queue, { payload: { data: { text: 'body' } } });
      if (!id) throw new Error('send returned no id');
      return id;
    };
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

    const finishedOld = await send(WEBHOOK_DELIVER_INBOUND_QUEUE);
    const finishedRecent = await send(WEBHOOK_DELIVER_INBOUND_QUEUE);
    const failedOld = await send(INBOUND_PROCESS_QUEUE);
    const waitingAncient = await send(WEBHOOK_DELIVER_INBOUND_QUEUE);
    const waitingFresh = await send(INBOUND_PROCESS_QUEUE);
    const archivedInbound = await send(WEBHOOK_DELIVER_INBOUND_QUEUE);
    const bounceOld = await send(WEBHOOK_DELIVER_QUEUE);
    const archivedBounce = await send(WEBHOOK_DELIVER_QUEUE);

    await finishJob({ pool: testDb.pool, id: finishedOld, completedOn: hoursAgo(2) });
    await finishJob({ pool: testDb.pool, id: finishedRecent, completedOn: hoursAgo(0.5) });
    await testDb.pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = $2 WHERE id = $1`, [failedOld, hoursAgo(2)]);
    await testDb.pool.query(`UPDATE pgboss.job SET created_on = $2, start_after = $2 WHERE id = $1`, [waitingAncient, daysAgo(3)]);
    await archiveJob({ pool: testDb.pool, id: archivedInbound });
    await finishJob({ pool: testDb.pool, id: bounceOld, completedOn: hoursAgo(2) });
    await archiveJob({ pool: testDb.pool, id: archivedBounce });

    const result = await applyInboundRetention({ db: testDb.db });

    expect(await jobExists({ pool: testDb.pool, id: finishedOld })).toBe(false);
    expect(await jobExists({ pool: testDb.pool, id: failedOld })).toBe(false);
    expect(await jobExists({ pool: testDb.pool, id: waitingAncient })).toBe(false);
    expect(await archivedJobExists({ pool: testDb.pool, id: archivedInbound })).toBe(false);
    expect(await jobExists({ pool: testDb.pool, id: finishedRecent })).toBe(true);
    expect(await jobExists({ pool: testDb.pool, id: waitingFresh })).toBe(true);
    // Other event types keep their own retention.
    expect(await jobExists({ pool: testDb.pool, id: bounceOld })).toBe(true);
    expect(await archivedJobExists({ pool: testDb.pool, id: archivedBounce })).toBe(true);
    expect(result.jobsDeleted).toBe(3);
    expect(result.archivedJobsDeleted).toBe(1);
  });
});
