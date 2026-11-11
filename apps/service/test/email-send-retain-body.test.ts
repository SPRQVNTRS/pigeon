/**
 * email.send with `retain_body: false`: the body is gone once the job is over.
 *
 * Real throwaway Postgres and a real pg-boss 10 queue, see
 * test/support/test-database.ts (local: DB_PORT=5433 pnpm test). Only the SES
 * call is faked, because nothing here may send mail.
 *
 * Jobs go through the real boss: send, fetch with metadata, run the handler,
 * then complete, in the order the pg-boss worker does it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { emails } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp, seedEmail, seedSuppression } from './support/seed';
import { jobExists } from './support/queue-jobs';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));
const sendEmailMock = vi.hoisted(() => vi.fn());

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock('#app/lib/ses', () => ({ sendEmail: sendEmailMock }));

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

const { createEmailSendHandler } = await import('#app/workflows/email-send');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ queues: ['email.send'] });
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

beforeEach(() => {
  sendEmailMock.mockReset();
  // message_id is unique in the emails table, so every send gets its own.
  sendEmailMock.mockImplementation(async () => ({ messageId: randomUUID() }));
});

interface Queued {
  appId: string;
  emailId: string;
  jobId: string;
}

/** An emails row with a body, and the email.send job that goes with it. */
async function queueMail(opts: { retainBody?: boolean; retryLimit?: number; to?: string }): Promise<Queued> {
  const to = opts.to ?? 'recipient@example.com';
  const appId = await seedApp({ db: testDb.db });
  const emailId = await seedEmail({
    db: testDb.db,
    appId,
    overrides: { toAddresses: [to], status: 'queued' },
  });
  const jobId = await testDb.boss.send(
    'email.send',
    {
      emailId,
      appId,
      domainId: 'dom-test',
      from: 'noreply@mail.example.com',
      to: [to],
      subject: 'Subject',
      html: '<p>reset link</p>',
      text: 'reset link',
      ...(opts.retainBody === undefined ? {} : { retainBody: opts.retainBody }),
    },
    opts.retryLimit === undefined ? {} : { retryLimit: opts.retryLimit },
  );
  if (!jobId) throw new Error('boss.send returned no id');
  return { appId, emailId, jobId };
}

/** Run the job the way the pg-boss worker would. Returns the handler's error, if any. */
async function runWorker(): Promise<unknown> {
  const jobs = await testDb.boss.fetch('email.send', { includeMetadata: true });
  const handler = createEmailSendHandler(testDb.boss);
  try {
    await handler(jobs as unknown as Parameters<typeof handler>[0]);
  } catch (err) {
    return err;
  }
  // pg-boss completes the job after a handler that did not throw.
  for (const job of jobs) await testDb.boss.complete('email.send', job.id);
  return undefined;
}

async function getEmail(id: string) {
  const [row] = await testDb.db.select().from(emails).where(eq(emails.id, id));
  return row;
}

describe('retain_body: false', () => {
  it('blanks the row and deletes the job once SES accepted the mail', async () => {
    const mail = await queueMail({ retainBody: false });

    const error = await runWorker();

    expect(error).toBeUndefined();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const row = await getEmail(mail.emailId);
    expect(row?.status).toBe('sent');
    expect(row?.html).toBeNull();
    expect(row?.text).toBeNull();
    expect(row?.headers).toEqual({});
    expect(row?.toAddresses).toEqual(['recipient@example.com']);
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(false);
  });

  it('blanks and deletes after a permanent SES failure', async () => {
    sendEmailMock.mockRejectedValue(Object.assign(new Error('rejected'), { name: 'MessageRejected' }));
    const mail = await queueMail({ retainBody: false });

    const error = await runWorker();

    expect(error).toBeUndefined();
    const row = await getEmail(mail.emailId);
    expect(row?.status).toBe('failed');
    expect(row?.html).toBeNull();
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(false);
  });

  it('blanks and deletes when every recipient is suppressed', async () => {
    const mail = await queueMail({ retainBody: false, to: 'blocked@example.com' });
    await seedSuppression({ db: testDb.db, appId: mail.appId, email: 'blocked@example.com', reason: 'complaint' });

    const error = await runWorker();

    expect(error).toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
    const row = await getEmail(mail.emailId);
    expect(row?.status).toBe('skipped_suppressed');
    expect(row?.html).toBeNull();
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(false);
  });

  it('keeps row body and job while a retry is still coming, then lets go on the last attempt', async () => {
    sendEmailMock.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const mail = await queueMail({ retainBody: false, retryLimit: 1 });

    // First attempt: retryCount 0 < retryLimit 1, so the job must stay whole.
    const firstError = await runWorker();
    expect(firstError).toBeInstanceOf(Error);
    await testDb.boss.fail('email.send', mail.jobId); // what pg-boss does with a thrown error
    const afterFirst = await getEmail(mail.emailId);
    expect(afterFirst?.html).toBe('<p>body</p>');
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(true);

    // pg-boss schedules the retry; bring it due and run the last attempt.
    await testDb.pool.query(`UPDATE pgboss.job SET start_after = now() WHERE id = $1`, [mail.jobId]);
    const lastError = await runWorker();

    expect(lastError).toBeUndefined();
    const row = await getEmail(mail.emailId);
    expect(row?.status).toBe('failed');
    expect(row?.html).toBeNull();
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(false);
  });
});

describe('default (retain_body not sent)', () => {
  it('keeps the body on the row and the job in pg-boss, as before', async () => {
    const mail = await queueMail({});

    const error = await runWorker();

    expect(error).toBeUndefined();
    const row = await getEmail(mail.emailId);
    expect(row?.status).toBe('sent');
    expect(row?.html).toBe('<p>body</p>');
    expect(row?.text).toBe('body');
    expect(await jobExists({ pool: testDb.pool, id: mail.jobId })).toBe(true);
  });

  it('still rethrows a transient failure so pg-boss retries', async () => {
    sendEmailMock.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const mail = await queueMail({ retryLimit: 0 });

    const error = await runWorker();

    expect(error).toBeInstanceOf(Error);
    expect((await getEmail(mail.emailId))?.html).toBe('<p>body</p>');
  });
});
