/**
 * Mail Retention Handler
 *
 * Applies each app's mail retention limits (blank bodies, delete old emails and
 * their email_events rows). Apps with NULL limits are not touched. Runs daily via pg-boss.
 * Logs counts only.
 */

import type { ScheduledTaskHandler, ScheduledTaskResult } from '../types';
import { db } from '#drizzle/db';
import { runMailRetention, type MailRetentionResult } from '#app/lib/mail-retention';

export const mailRetentionHandler: ScheduledTaskHandler<
  Record<string, unknown>,
  Omit<MailRetentionResult, 'perApp'>
> = async (): Promise<ScheduledTaskResult<Omit<MailRetentionResult, 'perApp'>>> => {
  const { perApp: _perApp, ...totals } = await runMailRetention({ db });

  return {
    status: 'completed',
    message:
      `Retention: ${totals.appsProcessed} app(s), ${totals.bodiesBlanked} bodies blanked, ` +
      `${totals.emailsDeleted} emails and ${totals.eventsDeleted} events deleted`,
    data: totals,
  };
};
