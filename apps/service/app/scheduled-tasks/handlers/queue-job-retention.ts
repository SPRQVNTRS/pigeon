/**
 * Queue Job Retention Handler
 *
 * Deletes finished pg-boss jobs of the mail queues one day after they
 * completed, from `pgboss.job` and `pgboss.archive`. Their data holds mail
 * bodies and recipient addresses. Runs hourly via pg-boss. Logs counts only.
 */

import type { ScheduledTaskHandler, ScheduledTaskResult } from '../types';
import { db } from '#drizzle/db';
import { EMAIL_SEND_QUEUE, SES_EVENT_QUEUE, WEBHOOK_DELIVER_QUEUE } from '#app/lib/queue-names';
import { pruneFinishedQueueJobs, type QueueJobRetentionResult } from '#app/lib/queue-job-retention';

export const queueJobRetentionHandler: ScheduledTaskHandler<
  Record<string, unknown>,
  QueueJobRetentionResult
> = async (): Promise<ScheduledTaskResult<QueueJobRetentionResult>> => {
  const result = await pruneFinishedQueueJobs({
    db,
    queues: [EMAIL_SEND_QUEUE, WEBHOOK_DELIVER_QUEUE, SES_EVENT_QUEUE],
  });

  return {
    status: 'completed',
    message: `Deleted ${result.jobsDeleted} finished jobs and ${result.archivedJobsDeleted} archived jobs`,
    data: result,
  };
};
