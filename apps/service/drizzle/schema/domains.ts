import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Domains
// =============================================================================

export const domains = pgTable(
  'domains',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    region: text('region').default('eu-central-1'),
    // dkimSelector reserved for future EXTERNAL signing; unused with EasyDKIM
    dkimSelector: text('dkim_selector').default('sprqvntrs'),
    // EasyDKIM CNAME token strings returned by AWS (three per domain)
    dkimTokens: text('dkim_tokens').array(),
    spfStatus: text('spf_status').default('pending'),
    dkimStatus: text('dkim_status').default('pending'),
    dmarcStatus: text('dmarc_status').default('pending'),
    mxStatus: text('mx_status').default('pending'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    lastVerificationError: text('last_verification_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('domains_name_idx').on(table.name),
    index('domains_app_id_idx').on(table.appId),
  ],
);

export type InsertDomain = InferInsertModel<typeof domains>;
export type SelectDomain = InferSelectModel<typeof domains>;
