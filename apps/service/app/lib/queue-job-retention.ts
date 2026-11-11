/**
 * Finished-job retention for the pg-boss queues that carry mail content and
 * recipient addresses (email.send, webhook.deliver, ses.event.process).
 *
 * Why Pigeon prunes pg-boss itself. The orchestrator is built inside
 * `@sprqvntrs/workflows`, which pins its own pg-boss, 10.4.2 (this service also
 * lists pg-boss 12 as a direct dependency, but the boss that runs the queues is
 * the workflows one; confirm with `pnpm why pg-boss`). The orchestrator passes
 * no retention options through, so the pg-boss 10.4.2 defaults apply, read from
 * node_modules/.pnpm/pg-boss@10.4.2/node_modules/pg-boss/src/attorney.js and
 * @sprqvntrs/workflows src/infrastructure/pg-boss.ts:
 *
 *   job table:     a finished job (completed, cancelled, failed) is moved to
 *                  `archive` archiveCompletedAfterSeconds after completed_on,
 *                  which createBoss sets to 604800 (7 days)
 *   archive table: a full copy of the job, `data` included, is deleted
 *                  deleteAfter (pg-boss default 7 days) after archived_on
 *   waiting jobs:  created or retry jobs are deleted after retentionMinutes,
 *                  which createBoss sets to 10080 (7 days)
 *
 * So a mail body sat in Postgres about 14 days after the send, in two tables.
 * Per-queue options cannot shorten that: in pg-boss 10 archive and delete
 * timing are constructor options of the whole boss, and we cannot set them
 * from here. This pass deletes finished jobs of the listed queues from both
 * tables one day after completed_on. It also works on pg-boss 12, which has
 * no archive table (the archive step is skipped when the table is absent).
 *
 * Deliberately left alone: waiting jobs (created, retry, active). Deleting
 * those would drop mail that has not been sent yet, and Pigeon sends other
 * products' mail too. Retry behaviour is untouched.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '#app/lib/db-types';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('QueueJobRetention');

/** Schema the orchestrator installs pg-boss in (createBoss default). */
export const PGBOSS_SCHEMA = 'pgboss';

/** How long a finished job of a pruned queue may stay in Postgres. */
export const FINISHED_JOB_RETENTION_SECONDS = 24 * 60 * 60;

export interface QueueJobRetentionResult {
  jobsDeleted: number;
  archivedJobsDeleted: number;
}

async function tableExists(opts: { db: Database; table: string }): Promise<boolean> {
  const { rows } = await opts.db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`${PGBOSS_SCHEMA}.${opts.table}`}) IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

export async function pruneFinishedQueueJobs(opts: {
  db: Database;
  queues: readonly string[];
  now?: Date;
  retentionSeconds?: number;
}): Promise<QueueJobRetentionResult> {
  const { db, queues, now = new Date(), retentionSeconds = FINISHED_JOB_RETENTION_SECONDS } = opts;
  const cutoff = new Date(now.getTime() - retentionSeconds * 1000);
  const queueList = sql.join(
    queues.map((queue) => sql`${queue}`),
    sql`, `,
  );

  // `state > 'active'` selects the finished states (completed, cancelled,
  // failed) by enum order, the same test pg-boss's own archive step uses.
  const jobs = await db.execute(sql`
    DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.job
    WHERE name IN (${queueList})
      AND state > 'active'
      AND completed_on < ${cutoff.toISOString()}::timestamptz
  `);

  let archivedJobsDeleted = 0;
  if (await tableExists({ db, table: 'archive' })) {
    const archived = await db.execute(sql`
      DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.archive
      WHERE name IN (${queueList})
        AND completed_on < ${cutoff.toISOString()}::timestamptz
    `);
    archivedJobsDeleted = archived.rowCount ?? 0;
  }

  const result = { jobsDeleted: jobs.rowCount ?? 0, archivedJobsDeleted };
  log.info('Finished queue jobs pruned', { ...result, queues: [...queues] });
  return result;
}
