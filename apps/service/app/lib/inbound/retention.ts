/**
 * Retention of everything that holds a received mail's body, sender, subject
 * or recipients inside pigeon. Hard limit: 7 days for every place.
 *
 *   place                                  limit (worst case incl. task cadence)
 *   S3 object incoming/<stage>/...         S3 lifecycle, scripts/lib/inbound-plan.ts
 *   inbound_emails row (recipients)        INBOUND_EMAIL_ROW_RETENTION_MS + cadence
 *   pgboss.job, finished (completed,       INBOUND_FINISHED_JOB_RETENTION_MS + cadence
 *     cancelled, failed)
 *   pgboss.job, any state (created,        INBOUND_JOB_MAX_AGE_MS + cadence
 *     retry, active)
 *   pgboss.archive (pg-boss 10 only)       every row of the two queues, each pass
 *
 * The queues are inbound.process (ids only) and webhook.deliver.inbound (the
 * email.received body). Other queues and event types keep their own retention
 * (app/lib/queue-job-retention.ts). Pigeon stores no webhook delivery log:
 * webhook-deliver only stamps webhooks.last_success_at / last_failure_at.
 *
 * The pass runs every INBOUND_RETENTION_INTERVAL_MINUTES (scheduled task
 * `inbound-retention`). The running boss is pg-boss 10.4.2 from
 * @sprqvntrs/workflows, whose own archive and delete windows are boss-wide
 * (7 + 7 days) and cannot be set per queue, so this pass is what enforces the
 * limit. Deleting an unfinished job older than INBOUND_JOB_MAX_AGE_MS drops
 * it; the mail can still be replayed from its inbound_emails row and S3.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '#app/lib/db-types';
import { INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE } from '#app/lib/queue-names';
import { PGBOSS_SCHEMA } from '#app/lib/queue-job-retention';
import { deleteInboundEmailsCreatedBefore } from '#app/models/inbound-emails.server';

import {
  INBOUND_EMAIL_ROW_RETENTION_MS,
  INBOUND_FINISHED_JOB_RETENTION_MS,
  INBOUND_JOB_MAX_AGE_MS,
} from './retention-limits';

export * from './retention-limits';

export const INBOUND_QUEUES = [INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE] as const;

export interface InboundRetentionResult {
  inboundEmailsDeleted: number;
  jobsDeleted: number;
  archivedJobsDeleted: number;
}

async function archiveTableExists(db: Database): Promise<boolean> {
  const { rows } = await db.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`${PGBOSS_SCHEMA}.archive`}) IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

export async function pruneInboundQueueJobs(opts: {
  db: Database;
  now?: Date;
}): Promise<{ jobsDeleted: number; archivedJobsDeleted: number }> {
  const { db, now = new Date() } = opts;
  const finishedCutoff = new Date(now.getTime() - INBOUND_FINISHED_JOB_RETENTION_MS).toISOString();
  const anyStateCutoff = new Date(now.getTime() - INBOUND_JOB_MAX_AGE_MS).toISOString();
  const queueList = sql.join(
    INBOUND_QUEUES.map((queue) => sql`${queue}`),
    sql`, `,
  );

  // `state > 'active'` selects the finished states by enum order, the same
  // test pg-boss's own archive step uses.
  const jobs = await db.execute(sql`
    DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.job
    WHERE name IN (${queueList})
      AND (
        (state > 'active' AND completed_on < ${finishedCutoff}::timestamptz)
        OR created_on < ${anyStateCutoff}::timestamptz
      )
  `);

  let archivedJobsDeleted = 0;
  if (await archiveTableExists(db)) {
    // An archived job never runs again, so every archived row of these queues goes.
    const archived = await db.execute(sql`
      DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.archive WHERE name IN (${queueList})
    `);
    archivedJobsDeleted = archived.rowCount ?? 0;
  }

  return { jobsDeleted: jobs.rowCount ?? 0, archivedJobsDeleted };
}

export async function applyInboundRetention(opts: { db: Database; now?: Date }): Promise<InboundRetentionResult> {
  const { db, now = new Date() } = opts;
  const inboundEmailsDeleted = await deleteInboundEmailsCreatedBefore({
    db,
    cutoff: new Date(now.getTime() - INBOUND_EMAIL_ROW_RETENTION_MS),
  });
  const jobs = await pruneInboundQueueJobs({ db, now });
  return { inboundEmailsDeleted, ...jobs };
}
