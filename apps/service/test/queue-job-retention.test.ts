/**
 * Finished-job pruning for the mail queues, against a real throwaway Postgres
 * with pg-boss 10 installed (local: DB_PORT=5433 pnpm test).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pruneFinishedQueueJobs } from '#app/lib/queue-job-retention';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { archiveJob, archivedJobExists, finishJob, jobExists, queueEmailJob } from './support/queue-jobs';
import { daysAgo, seedApp } from './support/seed';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

let testDb: TestDatabase;
let appId: string;

beforeAll(async () => {
  testDb = await createTestDatabase({ queues: ['email.send', 'domain.verify'] });
  appId = await seedApp({ db: testDb.db });
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

const QUEUES = ['email.send'] as const;

async function prune() {
  return pruneFinishedQueueJobs({ db: testDb.db, queues: QUEUES });
}

describe('pruneFinishedQueueJobs', () => {
  it('deletes a job that finished more than a day ago and keeps one that finished an hour ago', async () => {
    const old = await queueEmailJob({ testDb, appId, to: ['a@example.com'] });
    const recent = await queueEmailJob({ testDb, appId, to: ['b@example.com'] });
    await finishJob({ pool: testDb.pool, id: old, completedOn: daysAgo(2) });
    await finishJob({ pool: testDb.pool, id: recent, completedOn: new Date(Date.now() - 60 * 60 * 1000) });

    await prune();

    expect(await jobExists({ pool: testDb.pool, id: old })).toBe(false);
    expect(await jobExists({ pool: testDb.pool, id: recent })).toBe(true);
  });

  it('never deletes a job that has not finished, however old', async () => {
    const waiting = await queueEmailJob({ testDb, appId, to: ['c@example.com'] });
    await testDb.pool.query(`UPDATE pgboss.job SET created_on = $2, start_after = $2 WHERE id = $1`, [
      waiting,
      daysAgo(30),
    ]);

    await prune();

    expect(await jobExists({ pool: testDb.pool, id: waiting })).toBe(true);
  });

  it('deletes failed jobs after a day too', async () => {
    const failed = await queueEmailJob({ testDb, appId, to: ['d@example.com'], retryLimit: 0 });
    await testDb.pool.query(`UPDATE pgboss.job SET state = 'failed', completed_on = $2 WHERE id = $1`, [
      failed,
      daysAgo(2),
    ]);

    await prune();

    expect(await jobExists({ pool: testDb.pool, id: failed })).toBe(false);
  });

  it('prunes the archive table the same way', async () => {
    const old = await queueEmailJob({ testDb, appId, to: ['e@example.com'] });
    const recent = await queueEmailJob({ testDb, appId, to: ['f@example.com'] });
    await archiveJob({ pool: testDb.pool, id: old, completedOn: daysAgo(2) });
    await archiveJob({ pool: testDb.pool, id: recent, completedOn: new Date() });

    const result = await prune();

    expect(result.archivedJobsDeleted).toBeGreaterThanOrEqual(1);
    expect(await archivedJobExists({ pool: testDb.pool, id: old })).toBe(false);
    expect(await archivedJobExists({ pool: testDb.pool, id: recent })).toBe(true);
  });

  it('leaves the finished jobs of a queue that is not on the list alone', async () => {
    const other = await testDb.boss.send('domain.verify', { domainId: 'dom-test' });
    if (!other) throw new Error('boss.send returned no id');
    await finishJob({ pool: testDb.pool, id: other, completedOn: daysAgo(30) });

    await prune();

    expect(await jobExists({ pool: testDb.pool, id: other })).toBe(true);
  });
});
