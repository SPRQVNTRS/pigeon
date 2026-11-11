/**
 * Row factories for the real-database tests. Every factory takes overrides
 * and fills the rest with defaults that satisfy the NOT NULL columns.
 */
import { createId } from '@paralleldrive/cuid2';
import {
  apps,
  audiences,
  contacts,
  emailEvents,
  emails,
  inboundDomains,
  inboundEmails,
  suppressions,
  webhooks,
} from '#drizzle/schema/index';
import type { InsertEmail } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';

export async function seedApp(opts: {
  db: Database;
  name?: string;
  mailBodyRetentionDays?: number | null;
  mailRowRetentionDays?: number | null;
}): Promise<string> {
  const [app] = await opts.db
    .insert(apps)
    .values({
      name: opts.name ?? `app-${createId()}`,
      mailBodyRetentionDays: opts.mailBodyRetentionDays ?? null,
      mailRowRetentionDays: opts.mailRowRetentionDays ?? null,
    })
    .returning({ id: apps.id });
  if (!app) throw new Error('seedApp: no row returned');
  return app.id;
}

export async function seedEmail(opts: {
  db: Database;
  appId: string;
  overrides?: Partial<InsertEmail>;
}): Promise<string> {
  const [email] = await opts.db
    .insert(emails)
    .values({
      appId: opts.appId,
      domainId: 'dom-test',
      apiKeyId: 'key-test',
      fromAddress: 'noreply@mail.example.com',
      toAddresses: ['someone@example.com'],
      subject: 'Subject',
      html: '<p>body</p>',
      text: 'body',
      headers: { 'X-Test': '1' },
      status: 'sent',
      ...opts.overrides,
    })
    .returning({ id: emails.id });
  if (!email) throw new Error('seedEmail: no row returned');
  return email.id;
}

export async function seedEvent(opts: {
  db: Database;
  appId: string;
  emailId: string;
  receivedAt?: Date;
}): Promise<string> {
  const [event] = await opts.db
    .insert(emailEvents)
    .values({
      appId: opts.appId,
      emailId: opts.emailId,
      type: 'email.delivered',
      raw: { note: 'raw ses notification' },
      occurredAt: opts.receivedAt ?? new Date(),
      receivedAt: opts.receivedAt ?? new Date(),
    })
    .returning({ id: emailEvents.id });
  if (!event) throw new Error('seedEvent: no row returned');
  return event.id;
}

export async function seedContact(opts: {
  db: Database;
  appId: string;
  email: string;
}): Promise<string> {
  const [audience] = await opts.db
    .insert(audiences)
    .values({ appId: opts.appId, name: `audience-${createId()}` })
    .returning({ id: audiences.id });
  if (!audience) throw new Error('seedContact: no audience returned');
  const [contact] = await opts.db
    .insert(contacts)
    .values({ appId: opts.appId, audienceId: audience.id, email: opts.email })
    .returning({ id: contacts.id });
  if (!contact) throw new Error('seedContact: no contact returned');
  return contact.id;
}

export async function seedSuppression(opts: {
  db: Database;
  appId: string;
  email: string;
  reason: 'hard_bounce' | 'complaint';
}): Promise<string> {
  const [row] = await opts.db
    .insert(suppressions)
    .values({ appId: opts.appId, email: opts.email, reason: opts.reason })
    .returning({ id: suppressions.id });
  if (!row) throw new Error('seedSuppression: no row returned');
  return row.id;
}

export async function seedWebhook(opts: { db: Database; appId: string }): Promise<string> {
  const [row] = await opts.db
    .insert(webhooks)
    .values({
      appId: opts.appId,
      url: `https://hooks.example.test/${createId()}`,
      signingSecret: 'whsec-test-only',
      eventTypes: ['email.received'],
    })
    .returning({ id: webhooks.id });
  if (!row) throw new Error('seedWebhook: no row returned');
  return row.id;
}

/**
 * One received mail of an app, with its own inbound domain. `senderHash` is
 * what inbound.process would have written; null means not processed yet.
 */
export async function seedInboundEmail(opts: {
  db: Database;
  appId: string;
  senderHash: string | null;
}): Promise<{ id: string; s3Bucket: string; s3Key: string }> {
  const [domain] = await opts.db
    .insert(inboundDomains)
    .values({ appId: opts.appId, name: `reply-${createId()}.example.test` })
    .returning({ id: inboundDomains.id });
  if (!domain) throw new Error('seedInboundEmail: no domain returned');
  const sesMessageId = `ses-${createId()}`;
  const [row] = await opts.db
    .insert(inboundEmails)
    .values({
      appId: opts.appId,
      inboundDomainId: domain.id,
      sesMessageId,
      s3Bucket: 'example-pigeon-inbound',
      s3Key: `incoming/test/${sesMessageId}`,
      receivedAt: new Date(),
      recipientCount: 1,
      recipients: ['kc-test.0000@reply.example.test'],
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' },
      senderHash: opts.senderHash,
    })
    .returning({ id: inboundEmails.id, s3Bucket: inboundEmails.s3Bucket, s3Key: inboundEmails.s3Key });
  if (!row) throw new Error('seedInboundEmail: no row returned');
  return row;
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
