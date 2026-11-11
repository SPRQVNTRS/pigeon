import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Inbound domains
// =============================================================================

/**
 * A tenant-owned domain that receives mail through SES (for example the reply
 * domain of an app). The SES receipt rule stores each mail in S3 and notifies
 * pigeon; the recipient domain picks the owning app. `name` is stored lower case.
 */
export const inboundDomains = pgTable(
  'inbound_domains',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    region: text('region').default('eu-central-1').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('inbound_domains_name_uidx').on(table.name),
    index('inbound_domains_app_id_idx').on(table.appId),
  ],
);

export type InsertInboundDomain = InferInsertModel<typeof inboundDomains>;
export type SelectInboundDomain = InferSelectModel<typeof inboundDomains>;

// =============================================================================
// Inbound emails
// =============================================================================

/** SES receipt verdicts exactly as SES wrote them. A key SES did not send is absent. */
export interface InboundVerdicts {
  spf?: string;
  dkim?: string;
  spam?: string;
  virus?: string;
  /** Absent on rows received before pigeon read `dmarcVerdict` (2026-11-09). */
  dmarc?: string;
}

/**
 * One received mail per matched inbound domain. Holds no sender address, no
 * subject and no body: those stay in S3 (7-day lifecycle). `recipients` holds
 * the matched addresses so an operator can replay the mail; the
 * inbound-retention scheduled task deletes every row 7 days after `created_at`.
 *
 * `sender_hash` is a keyed hash of the From address (app/lib/inbound/sender-hash.ts),
 * never the address. inbound.process writes it after the MIME parse, so it is
 * null until then, and null on rows received before the column existed. The
 * recipient erase finds a sender's mail through it (app/lib/recipient-erase.ts).
 */
export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    inboundDomainId: text('inbound_domain_id')
      .notNull()
      .references(() => inboundDomains.id),
    sesMessageId: text('ses_message_id').notNull(),
    s3Bucket: text('s3_bucket').notNull(),
    s3Key: text('s3_key').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    recipientCount: integer('recipient_count').notNull(),
    recipients: text('recipients').array().notNull(),
    verdicts: jsonb('verdicts').$type<InboundVerdicts>().notNull(),
    senderHash: text('sender_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inbound_emails_ses_message_domain_uidx').on(table.sesMessageId, table.inboundDomainId),
    index('inbound_emails_app_id_idx').on(table.appId),
    index('inbound_emails_created_at_idx').on(table.createdAt),
    index('inbound_emails_app_id_sender_hash_idx').on(table.appId, table.senderHash),
  ],
);

export type InsertInboundEmail = InferInsertModel<typeof inboundEmails>;
export type SelectInboundEmail = InferSelectModel<typeof inboundEmails>;
