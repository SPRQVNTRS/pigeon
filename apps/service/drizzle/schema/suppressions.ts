import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

// =============================================================================
// Suppressions
// =============================================================================

export const suppressions = pgTable(
  'suppressions',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    email: citext('email').notNull(),
    reason: text('reason').notNull(),
    sourceEmailId: text('source_email_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('suppressions_app_id_email_idx').on(table.appId, table.email),
  ],
);

export type InsertSuppression = InferInsertModel<typeof suppressions>;
export type SelectSuppression = InferSelectModel<typeof suppressions>;
