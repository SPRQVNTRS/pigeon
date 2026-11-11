/**
 * Idempotency Cleanup Handler
 *
 * Deletes idempotent_requests rows older than 25 hours to prevent unbounded table growth.
 * Runs hourly via pg-boss.
 */

import { lt } from 'drizzle-orm';
import type { ScheduledTaskHandler, ScheduledTaskResult } from '../types';
import { createComponentLogger } from '#app/lib/logger';
import { db } from '#drizzle/db';
import { idempotentRequests } from '#drizzle/schema/index';

const log = createComponentLogger('IdempotencyCleanup');

/**
 * Remove idempotency records older than 25 hours.
 */
export const idempotencyCleanupHandler: ScheduledTaskHandler<
  Record<string, unknown>,
  { deleted: number }
> = async (): Promise<ScheduledTaskResult<{ deleted: number }>> => {
  const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000);

  const deleted = await db
    .delete(idempotentRequests)
    .where(lt(idempotentRequests.createdAt, cutoff))
    .returning({ id: idempotentRequests.apiKeyId });

  log.info('Idempotency cleanup complete', { deleted: deleted.length, cutoff });

  return {
    status: 'completed',
    message: `Deleted ${deleted.length} expired idempotency records`,
    data: { deleted: deleted.length },
  };
};
