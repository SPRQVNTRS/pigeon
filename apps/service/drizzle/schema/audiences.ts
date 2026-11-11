import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

// =============================================================================
// Audiences
// =============================================================================

export const audiences = pgTable(
  'audiences',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('audiences_app_id_idx').on(table.appId),
  ],
);

export type InsertAudience = InferInsertModel<typeof audiences>;
export type SelectAudience = InferSelectModel<typeof audiences>;
