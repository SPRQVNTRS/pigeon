/**
 * pg-boss row helpers for the real-database tests.
 *
 * Jobs are queued through the real boss (pg-boss 10.4.2, see test-database.ts),
 * and inspected with plain SQL, because the point of the tests is what Postgres
 * holds, not what the boss API reports.
 */
import type pg from 'pg';
import type { TestDatabase } from './test-database';

export async function queueEmailJob(opts: {
  testDb: TestDatabase;
  appId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  retainBody?: boolean;
  retryLimit?: number;
}): Promise<string> {
  const { testDb, ...payload } = opts;
  const id = await testDb.boss.send(
    'email.send',
    {
      emailId: 'email-test',
      domainId: 'dom-test',
      from: 'noreply@mail.example.com',
      subject: 'Subject',
      html: '<p>reset link</p>',
      text: 'reset link',
      ...payload,
      retryLimit: undefined,
    },
    opts.retryLimit === undefined ? {} : { retryLimit: opts.retryLimit },
  );
  if (!id) throw new Error('queueEmailJob: boss.send returned no id');
  return id;
}

/**
 * An email.received delivery as app/lib/webhook-fanout.ts queues it on
 * webhook.deliver.inbound: the sender sits in payload.data.from.
 */
export async function queueInboundDeliveryJob(opts: {
  testDb: TestDatabase;
  appId: string;
  webhookId: string;
  from: string;
  inboundEmailId?: string;
}): Promise<string> {
  const id = await opts.testDb.boss.send('webhook.deliver.inbound', {
    webhookId: opts.webhookId,
    url: 'https://hooks.example.test/inbound',
    signingSecret: 'whsec-test-only',
    eventType: 'email.received',
    payload: {
      id: 'delivery-test',
      type: 'email.received',
      organization_id: opts.appId,
      email_id: opts.inboundEmailId ?? 'ie-test',
      occurred_at: new Date().toISOString(),
      data: {
        recipient: 'kc-test.0000@reply.example.test',
        from: opts.from,
        subject: 'Re: your ticket',
        text: 'reply body',
      },
    },
  });
  if (!id) throw new Error('queueInboundDeliveryJob: boss.send returned no id');
  return id;
}

/** An inbound.process job: ids only, as the inbound route queues it. */
export async function queueInboundProcessJob(opts: {
  testDb: TestDatabase;
  appId: string;
  inboundEmailId: string;
}): Promise<string> {
  const id = await opts.testDb.boss.send('inbound.process', {
    inboundEmailId: opts.inboundEmailId,
    appId: opts.appId,
  });
  if (!id) throw new Error('queueInboundProcessJob: boss.send returned no id');
  return id;
}

export async function jobExists(opts: { pool: pg.Pool; id: string }): Promise<boolean> {
  const { rows } = await opts.pool.query('SELECT 1 FROM pgboss.job WHERE id = $1', [opts.id]);
  return rows.length > 0;
}

export async function archivedJobExists(opts: { pool: pg.Pool; id: string }): Promise<boolean> {
  const { rows } = await opts.pool.query('SELECT 1 FROM pgboss.archive WHERE id = $1', [opts.id]);
  return rows.length > 0;
}

const ARCHIVE_COLUMNS =
  'id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff, start_after, started_on, singleton_key, singleton_on, expire_in, created_on, completed_on, keep_until, dead_letter, policy, output';

/**
 * Do by hand what pg-boss 10 maintenance does after archiveCompletedAfterSeconds:
 * mark the job completed and move it to pgboss.archive.
 */
export async function archiveJob(opts: { pool: pg.Pool; id: string; completedOn?: Date }): Promise<void> {
  const { pool, id, completedOn = new Date() } = opts;
  await pool.query(`UPDATE pgboss.job SET state = 'completed', completed_on = $2 WHERE id = $1`, [
    id,
    completedOn,
  ]);
  await pool.query(`INSERT INTO pgboss.archive (${ARCHIVE_COLUMNS}) SELECT ${ARCHIVE_COLUMNS} FROM pgboss.job WHERE id = $1`, [id]);
  await pool.query('DELETE FROM pgboss.job WHERE id = $1', [id]);
}

/** Mark a queued job finished at a given time, still in pgboss.job. */
export async function finishJob(opts: { pool: pg.Pool; id: string; completedOn: Date }): Promise<void> {
  await opts.pool.query(`UPDATE pgboss.job SET state = 'completed', completed_on = $2 WHERE id = $1`, [
    opts.id,
    opts.completedOn,
  ]);
}
