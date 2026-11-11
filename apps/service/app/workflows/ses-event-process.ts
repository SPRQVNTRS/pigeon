/**
 * ses.event.process worker
 *
 * Processes SES bounce / complaint / delivery notifications that arrived via
 * SNS. Writes `email_events`, updates `emails.status`, populates `suppressions`
 * on permanent bounce/complaint, cascades to `contacts`, and fans out
 * `webhook.deliver` jobs for each matching consumer webhook.
 *
 * Same registration pattern as domain-verify.ts and email-send.ts.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { contacts, emailEvents, emails, suppressions } from '#drizzle/schema';
import { createComponentLogger } from '#app/lib/logger';
import { SES_EVENT_QUEUE, WEBHOOK_DELIVER_QUEUE } from '#app/lib/queue-names';
import { enqueueWebhookFanout } from '#app/lib/webhook-fanout';

const log = createComponentLogger('SesEventProcessWorker');

// Defined in #app/lib/queue-names, re-exported for existing importers.
export { SES_EVENT_QUEUE, WEBHOOK_DELIVER_QUEUE };

// -----------------------------------------------------------------------------
// SES notification types (structural subset — extra fields are tolerated)
// -----------------------------------------------------------------------------

interface SesMail {
  messageId: string;
  timestamp?: string;
  source?: string;
  destination?: string[];
}

interface SesBounceRecipient {
  emailAddress: string;
  action?: string;
  status?: string;
  diagnosticCode?: string;
}

interface SesBounce {
  bounceType: 'Permanent' | 'Transient' | 'Undetermined' | string;
  bounceSubType?: string;
  bouncedRecipients: SesBounceRecipient[];
  timestamp?: string;
}

interface SesComplaintRecipient {
  emailAddress: string;
}

interface SesComplaint {
  complainedRecipients: SesComplaintRecipient[];
  timestamp?: string;
  complaintFeedbackType?: string;
}

interface SesDelivery {
  timestamp?: string;
  recipients?: string[];
}

export interface SesNotification {
  /** Legacy field name used in older SES notification formats. */
  notificationType?: 'Bounce' | 'Complaint' | 'Delivery' | string;
  /**
   * New field name used in SES configuration-set event notifications.
   * SES sends either `eventType` or `notificationType` (or both) depending
   * on the config-set version. Always prefer `eventType` if present.
   */
  eventType?: 'Bounce' | 'Complaint' | 'Delivery' | string;
  mail: SesMail;
  bounce?: SesBounce;
  complaint?: SesComplaint;
  delivery?: SesDelivery;
}

// -----------------------------------------------------------------------------
// Worker registration
// -----------------------------------------------------------------------------

export interface SesEventPayload {
  /** Parsed SES notification (from the SNS `Message` field). */
  notification: SesNotification;
}

interface SesEventJob {
  data: SesEventPayload;
}

export interface BossWorker {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    options: { batchSize: number },
    handler: (jobs: SesEventJob[]) => Promise<void>,
  ): unknown;
  send(
    name: string,
    data: object,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
}

/**
 * Register the ses.event.process worker with the given pg-boss instance.
 * Creates the queue first (idempotent — pg-boss uses ON CONFLICT DO NOTHING).
 */
export async function registerSesEventProcessWorker(boss: BossWorker): Promise<void> {
  await boss.createQueue(SES_EVENT_QUEUE);
  boss.work(SES_EVENT_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    await handleSesEvent(job.data, boss);
  });
  log.info(`${SES_EVENT_QUEUE} worker registered`);
}

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

type EventKind =
  | { type: 'email.bounced'; permanent: boolean; subtype?: string; recipients: string[]; diagnosticCode?: string }
  | { type: 'email.complained'; subtype?: string; recipients: string[] }
  | { type: 'email.delivered'; recipients: string[] };

function classify(n: SesNotification): EventKind | null {
  // SES configuration-set events use `eventType`; older formats use `notificationType`.
  // Prefer eventType when present.
  const type = n.eventType ?? n.notificationType;

  if (type === 'Bounce' && n.bounce) {
    const permanent = n.bounce.bounceType === 'Permanent';
    const recipients = n.bounce.bouncedRecipients.map((r) => r.emailAddress);
    const diagnosticCode = n.bounce.bouncedRecipients[0]?.diagnosticCode;
    return {
      type: 'email.bounced',
      permanent,
      subtype: n.bounce.bounceSubType,
      recipients,
      diagnosticCode,
    };
  }
  if (type === 'Complaint' && n.complaint) {
    return {
      type: 'email.complained',
      subtype: n.complaint.complaintFeedbackType,
      recipients: n.complaint.complainedRecipients.map((r) => r.emailAddress),
    };
  }
  if (type === 'Delivery') {
    return {
      type: 'email.delivered',
      recipients: n.delivery?.recipients ?? [],
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

async function handleSesEvent(payload: SesEventPayload, boss: BossWorker): Promise<void> {
  const notification = payload.notification;
  const sesMessageId = notification.mail?.messageId;
  if (!sesMessageId) {
    log.warn('SES notification missing mail.messageId, dropping', { notification });
    return;
  }

  const kind = classify(notification);
  if (!kind) {
    log.warn('Unrecognized SES notification type', { notificationType: notification.notificationType, eventType: notification.eventType });
    return;
  }

  // Look up our email row by SES messageId. `emails.messageId` is globally unique.
  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.messageId, sesMessageId))
    .limit(1);

  if (!email) {
    // Could be a bounce for an email we didn't send via this service.
    log.info('No matching email row for SES messageId, ignoring', { sesMessageId });
    return;
  }

  const appId = email.appId;
  const occurredAt =
    parseTimestamp(
      notification.bounce?.timestamp ?? notification.complaint?.timestamp ?? notification.delivery?.timestamp,
    ) ?? new Date();

  // Write email_events row
  await db.insert(emailEvents).values({
    appId,
    emailId: email.id,
    type: kind.type,
    subtype: 'subtype' in kind ? kind.subtype ?? null : null,
    raw: notification as unknown as Record<string, unknown>,
    occurredAt,
  });

  // Update emails.status
  if (kind.type === 'email.delivered') {
    await db
      .update(emails)
      .set({ status: 'delivered', deliveredAt: occurredAt })
      .where(and(eq(emails.id, email.id), eq(emails.appId, appId)));
  } else if (kind.type === 'email.bounced') {
    await db
      .update(emails)
      .set({
        status: 'bounced',
        failureReason: kind.diagnosticCode ?? kind.subtype ?? 'bounced',
      })
      .where(and(eq(emails.id, email.id), eq(emails.appId, appId)));
  } else if (kind.type === 'email.complained') {
    await db
      .update(emails)
      .set({ status: 'complained', failureReason: kind.subtype ?? 'complaint' })
      .where(and(eq(emails.id, email.id), eq(emails.appId, appId)));
  }

  // Permanent bounce / any complaint → suppression + contact cascade.
  const shouldSuppress =
    (kind.type === 'email.bounced' && kind.permanent) || kind.type === 'email.complained';

  if (shouldSuppress) {
    const reason = kind.type === 'email.complained' ? 'complaint' : 'hard_bounce';
    await addSuppressions(appId, email.id, kind.recipients, reason);
    await cascadeContacts(appId, kind.recipients, kind.type === 'email.complained');
  }

  // Fan out to consumer webhooks
  await fanOutSesEvent(boss, appId, email.id, occurredAt, kind, notification);
}

function parseTimestamp(ts?: string): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

async function addSuppressions(
  appId: string,
  sourceEmailId: string,
  recipients: string[],
  reason: string,
): Promise<void> {
  if (recipients.length === 0) return;
  const rows = recipients.map((email) => ({
    appId,
    email,
    reason,
    sourceEmailId,
  }));
  await db.insert(suppressions).values(rows).onConflictDoNothing();
}

/**
 * Bulk-flip matching contacts across all audiences in this app.
 * Per counsel: the unique index is (audienceId, email) so the same address may
 * exist in multiple audiences — we update all of them.
 */
async function cascadeContacts(
  appId: string,
  recipients: string[],
  isComplaint: boolean,
): Promise<void> {
  if (recipients.length === 0) return;
  const now = new Date();
  const status = isComplaint ? 'complained' : 'bounced';
  const timestampColumn = isComplaint ? { complainedAt: now } : { bouncedAt: now };

  await db
    .update(contacts)
    .set({
      status,
      unsubscribedAt: now,
      ...timestampColumn,
      updatedAt: now,
    })
    .where(
      and(
        eq(contacts.appId, appId),
        // citext comparison: case-insensitive; Postgres will handle it.
        inArray(sql`lower(${contacts.email}::text)`, recipients.map((r) => r.toLowerCase())),
      ),
    );
}

// -----------------------------------------------------------------------------
// Webhook fan-out
// -----------------------------------------------------------------------------

async function fanOutSesEvent(
  boss: BossWorker,
  appId: string,
  emailId: string,
  occurredAt: Date,
  kind: EventKind,
  raw: SesNotification,
): Promise<void> {
  await enqueueWebhookFanout({
    boss,
    appId,
    emailId,
    occurredAt,
    eventType: kind.type,
    deliveries: kind.recipients.map((recipient) => buildPayloadData(kind, recipient, raw)),
  });
}

function buildPayloadData(
  kind: EventKind,
  recipient: string,
  raw: SesNotification,
): Record<string, unknown> {
  if (kind.type === 'email.bounced') {
    return {
      recipient,
      bounce_type: raw.bounce?.bounceType,
      bounce_subtype: kind.subtype,
      diagnostic_code: kind.diagnosticCode,
    };
  }
  if (kind.type === 'email.complained') {
    return {
      recipient,
      complaint_feedback_type: kind.subtype,
    };
  }
  return { recipient };
}

// -----------------------------------------------------------------------------
// Test-only exports
// -----------------------------------------------------------------------------

export const __test__ = {
  classify,
  addSuppressions,
  cascadeContacts,
  handleSesEvent,
};
