/**
 * Mail retention pass.
 *
 * Retention is per app and off by default: `apps.mail_body_retention_days` and
 * `apps.mail_row_retention_days` are NULL until someone sets them, and an app
 * with NULL limits is never touched. Pigeon serves several products, so no
 * product may lose mail it did not opt out of keeping.
 *
 * Two limits per app, both measured from `emails.created_at`:
 *
 * - body limit: blank `html`, `text` and `headers` (the body can hold a reset
 *   link). The row, its recipients, subject and status stay.
 * - row limit: delete the `emails` row and its `email_events`. Events are also
 *   pruned by their own `received_at`, so an event whose email row is already
 *   gone cannot outlive the limit either.
 *
 * Only counts leave this module. It never returns or logs an address or a
 * subject.
 */
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { apps, emailEvents, emails } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import { BLANKED_EMAIL_BODY } from '#app/lib/blank-email-body';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('MailRetention');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MailRetentionAppResult {
  appId: string;
  bodiesBlanked: number;
  emailsDeleted: number;
  eventsDeleted: number;
}

export interface MailRetentionResult {
  appsProcessed: number;
  bodiesBlanked: number;
  emailsDeleted: number;
  eventsDeleted: number;
  perApp: MailRetentionAppResult[];
}

function cutoffFor({ now, days }: { now: Date; days: number }): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Blank html, text and headers on emails older than the cutoff.
 * Rows that are already blank are skipped, so the count is real work done.
 */
async function blankBodies(opts: { db: Database; appId: string; cutoff: Date }): Promise<number> {
  const { db, appId, cutoff } = opts;
  const blanked = await db
    .update(emails)
    .set({ ...BLANKED_EMAIL_BODY })
    .where(
      and(
        eq(emails.appId, appId),
        lt(emails.createdAt, cutoff),
        or(
          isNotNull(emails.html),
          isNotNull(emails.text),
          sql`(${emails.headers} IS NOT NULL AND ${emails.headers} <> '{}'::jsonb)`,
        ),
      ),
    )
    .returning({ id: emails.id });
  return blanked.length;
}

/**
 * Delete emails older than the cutoff, their events, and any event of the app
 * whose own received_at is older than the cutoff. One transaction per app, so
 * an email never loses its row while its events stay.
 */
async function deleteRows(opts: {
  db: Database;
  appId: string;
  cutoff: Date;
}): Promise<{ emailsDeleted: number; eventsDeleted: number }> {
  const { db, appId, cutoff } = opts;
  return db.transaction(async (tx) => {
    const expiredEmailIds = tx
      .select({ id: emails.id })
      .from(emails)
      .where(and(eq(emails.appId, appId), lt(emails.createdAt, cutoff)));

    const eventsOfExpiredEmails = await tx
      .delete(emailEvents)
      .where(and(eq(emailEvents.appId, appId), inArray(emailEvents.emailId, expiredEmailIds)))
      .returning({ id: emailEvents.id });

    const expiredEvents = await tx
      .delete(emailEvents)
      .where(and(eq(emailEvents.appId, appId), lt(emailEvents.receivedAt, cutoff)))
      .returning({ id: emailEvents.id });

    const expiredEmails = await tx
      .delete(emails)
      .where(and(eq(emails.appId, appId), lt(emails.createdAt, cutoff)))
      .returning({ id: emails.id });

    return {
      emailsDeleted: expiredEmails.length,
      eventsDeleted: eventsOfExpiredEmails.length + expiredEvents.length,
    };
  });
}

/**
 * Run the retention pass for every app that has at least one limit set.
 * Pass `now` explicitly in tests.
 */
export async function runMailRetention(opts: {
  db: Database;
  now?: Date;
}): Promise<MailRetentionResult> {
  const { db, now = new Date() } = opts;

  const limitedApps = await db
    .select({
      id: apps.id,
      bodyDays: apps.mailBodyRetentionDays,
      rowDays: apps.mailRowRetentionDays,
    })
    .from(apps)
    .where(or(isNotNull(apps.mailBodyRetentionDays), isNotNull(apps.mailRowRetentionDays)));

  const result: MailRetentionResult = {
    appsProcessed: limitedApps.length,
    bodiesBlanked: 0,
    emailsDeleted: 0,
    eventsDeleted: 0,
    perApp: [],
  };

  for (const app of limitedApps) {
    const appResult: MailRetentionAppResult = {
      appId: app.id,
      bodiesBlanked: 0,
      emailsDeleted: 0,
      eventsDeleted: 0,
    };

    // Blank first: if the same app also has a row limit shorter than the body
    // limit, the rows below are deleted anyway and the order costs nothing.
    if (app.bodyDays !== null) {
      appResult.bodiesBlanked = await blankBodies({
        db,
        appId: app.id,
        cutoff: cutoffFor({ now, days: app.bodyDays }),
      });
    }

    if (app.rowDays !== null) {
      const deleted = await deleteRows({
        db,
        appId: app.id,
        cutoff: cutoffFor({ now, days: app.rowDays }),
      });
      appResult.emailsDeleted = deleted.emailsDeleted;
      appResult.eventsDeleted = deleted.eventsDeleted;
    }

    result.bodiesBlanked += appResult.bodiesBlanked;
    result.emailsDeleted += appResult.emailsDeleted;
    result.eventsDeleted += appResult.eventsDeleted;
    result.perApp.push(appResult);

    log.info('Mail retention applied to app', { ...appResult });
  }

  log.info('Mail retention pass complete', {
    appsProcessed: result.appsProcessed,
    bodiesBlanked: result.bodiesBlanked,
    emailsDeleted: result.emailsDeleted,
    eventsDeleted: result.eventsDeleted,
  });

  return result;
}
