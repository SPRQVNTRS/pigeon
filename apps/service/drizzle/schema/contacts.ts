import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

// =============================================================================
// Contacts
// =============================================================================

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    audienceId: text('audience_id').notNull(),
    email: citext('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    attributes: jsonb('attributes').default({}),
    status: text('status').default('subscribed'),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    complainedAt: timestamp('complained_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('contacts_audience_id_email_idx').on(table.audienceId, table.email),
    index('contacts_app_id_status_idx').on(table.appId, table.status),
  ],
);

export type InsertContact = InferInsertModel<typeof contacts>;
export type SelectContact = InferSelectModel<typeof contacts>;
