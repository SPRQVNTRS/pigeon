/**
 * Inbound Retention Handler
 *
 * Deletes inbound_emails rows (they hold recipients) and the pg-boss jobs of
 * the inbound queues (the email.received deliveries hold the mail body) once
 * they pass their limits. Limits and the full list of places live in
 * app/lib/inbound/retention.ts. Logs counts only.
 */

import type { ScheduledTaskHandler, ScheduledTaskResult } from '../types';
import { db } from '#drizzle/db';
import { createComponentLogger } from '#app/lib/logger';
import { applyInboundRetention, type InboundRetentionResult } from '#app/lib/inbound/retention';

const log = createComponentLogger('InboundRetention');

export const inboundRetentionHandler: ScheduledTaskHandler<
  Record<string, unknown>,
  InboundRetentionResult
> = async (): Promise<ScheduledTaskResult<InboundRetentionResult>> => {
  const result = await applyInboundRetention({ db });
  log.info('Inbound retention applied', { ...result });
  return {
    status: 'completed',
    message:
      `Deleted ${result.inboundEmailsDeleted} inbound emails, ${result.jobsDeleted} jobs ` +
      `and ${result.archivedJobsDeleted} archived jobs`,
    data: result,
  };
};
