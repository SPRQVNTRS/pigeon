import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Email Events
// =============================================================================

export const emailEvents = pgTable(
  'email_events',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    emailId: text('email_id').notNull(),
    type: text('type').notNull(),
    subtype: text('subtype'),
    raw: jsonb('raw').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('email_events_email_id_idx').on(table.emailId),
    index('email_events_app_id_occurred_at_idx').on(table.appId, table.occurredAt),
    index('email_events_received_at_idx').on(table.receivedAt),
  ],
);

export type InsertEmailEvent = InferInsertModel<typeof emailEvents>;
export type SelectEmailEvent = InferSelectModel<typeof emailEvents>;
