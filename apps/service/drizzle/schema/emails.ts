import { createId } from '@paralleldrive/cuid2';
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Emails
// =============================================================================

export const emails = pgTable(
  'emails',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    domainId: text('domain_id').notNull(),
    apiKeyId: text('api_key_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    messageId: text('message_id'),
    fromAddress: text('from_address').notNull(),
    toAddresses: text('to_addresses').array().notNull(),
    ccAddresses: text('cc_addresses').array().default([]),
    bccAddresses: text('bcc_addresses').array().default([]),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    html: text('html'),
    text: text('text'),
    headers: jsonb('headers').default({}),
    attachmentsCount: integer('attachments_count').default(0),
    status: text('status').default('queued'),
    failureReason: text('failure_reason'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('emails_message_id_idx').on(table.messageId),
    uniqueIndex('emails_app_id_idempotency_key_idx')
      .on(table.appId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    index('emails_app_id_status_idx').on(table.appId, table.status),
    index('emails_app_id_domain_id_idx').on(table.appId, table.domainId),
  ],
);

export type InsertEmail = InferInsertModel<typeof emails>;
export type SelectEmail = InferSelectModel<typeof emails>;
