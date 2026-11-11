import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// =============================================================================
// API Keys
// =============================================================================

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    appId: text('app_id').notNull(),
    name: text('name').notNull(),
    hashedKey: text('hashed_key').notNull(),
    prefix: text('prefix').notNull(),
    rateLimitPerSecond: integer('rate_limit_per_second').default(10),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('api_keys_hashed_key_idx').on(table.hashedKey),
    index('api_keys_app_id_idx').on(table.appId),
    index('api_keys_prefix_idx').on(table.prefix),
  ],
);

export type InsertApiKey = InferInsertModel<typeof apiKeys>;
export type SelectApiKey = InferSelectModel<typeof apiKeys>;
