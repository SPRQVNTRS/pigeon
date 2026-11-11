import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// =============================================================================
// Webhooks
// =============================================================================

export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    url: text('url').notNull(),
    signingSecret: text('signing_secret').notNull(),
    eventTypes: text('event_types').array().default(['*']),
    enabled: boolean('enabled').default(true),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('webhooks_app_id_idx').on(table.appId),
    uniqueIndex('webhooks_app_id_url_uidx').on(table.appId, table.url),
  ],
);

export type InsertWebhook = InferInsertModel<typeof webhooks>;
export type SelectWebhook = InferSelectModel<typeof webhooks>;
