import { db } from '#drizzle/db';
import { emails, emailEvents, webhooks } from '#drizzle/schema/index';
import { eq, gte, and, count, desc, isNotNull, sql } from 'drizzle-orm';

// =============================================================================
// Dashboard Stats
// =============================================================================

export type Range = '7d' | '30d' | '90d';

function rangeToMs(range: Range): number {
  if (range === '30d') return 30 * 24 * 60 * 60 * 1000;
  if (range === '90d') return 90 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

export function parseRange(raw: string | null): Range {
  if (raw === '30d' || raw === '90d') return raw;
  return '7d';
}

export interface DashboardStats {
  emailSentByApp: { appId: string; count: number }[];
  bounceByApp: { appId: string; count: number }[];
  failedWebhooks: { id: string; appId: string; url: string; lastFailureAt: Date }[];
  recentEmails: {
    id: string;
    appId: string;
    status: string;
    subject: string;
    toAddresses: string[];
    sentAt: Date | null;
    createdAt: Date;
  }[];
}

export async function getDashboardStats(range: Range): Promise<DashboardStats> {
  const rangeStart = new Date(Date.now() - rangeToMs(range));

  const [emailSentByApp, bounceByApp, failedWebhooks, recentEmails] = await Promise.all([
    // emails sent (status='delivered') grouped by appId
    db
      .select({ appId: emails.appId, count: count() })
      .from(emails)
      .where(
        and(
          eq(emails.status, 'delivered'),
          // sentAt is nullable; use sql cast to satisfy drizzle's type system
          sql`${emails.sentAt} >= ${rangeStart}`,
        ),
      )
      .groupBy(emails.appId),

    // bounces grouped by appId
    db
      .select({ appId: emailEvents.appId, count: count() })
      .from(emailEvents)
      .where(
        and(
          eq(emailEvents.type, 'email.bounced'),
          gte(emailEvents.occurredAt, rangeStart),
        ),
      )
      .groupBy(emailEvents.appId),

    // recently-failed webhooks (lastFailureAt within range)
    db
      .select({
        id: webhooks.id,
        appId: webhooks.appId,
        url: webhooks.url,
        lastFailureAt: webhooks.lastFailureAt,
      })
      .from(webhooks)
      .where(
        and(
          isNotNull(webhooks.lastFailureAt),
          sql`${webhooks.lastFailureAt} >= ${rangeStart}`,
        ),
      )
      .orderBy(desc(sql`${webhooks.lastFailureAt}`))
      .limit(20),

    // last 20 emails across all apps (no time filter)
    db
      .select({
        id: emails.id,
        appId: emails.appId,
        status: emails.status,
        subject: emails.subject,
        toAddresses: emails.toAddresses,
        sentAt: emails.sentAt,
        createdAt: emails.createdAt,
      })
      .from(emails)
      .orderBy(desc(emails.createdAt))
      .limit(20),
  ]);

  return {
    emailSentByApp: emailSentByApp.map((r) => ({ appId: r.appId, count: r.count })),
    bounceByApp: bounceByApp.map((r) => ({ appId: r.appId, count: r.count })),
    failedWebhooks: failedWebhooks.map((r) => ({
      id: r.id,
      appId: r.appId,
      url: r.url,
      lastFailureAt: r.lastFailureAt!, // guaranteed non-null by isNotNull filter
    })),
    recentEmails: recentEmails.map((r) => ({
      ...r,
      status: r.status ?? 'queued',
    })),
  };
}
