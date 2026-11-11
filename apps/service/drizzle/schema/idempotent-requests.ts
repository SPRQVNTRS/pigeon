import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

// =============================================================================
// Idempotent Requests
// =============================================================================

export const idempotentRequests = pgTable(
  'idempotent_requests',
  {
    apiKeyId: text('api_key_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.apiKeyId, table.key] }),
    index('idempotent_requests_created_at_idx').on(table.createdAt),
  ],
);

export type InsertIdempotentRequest = InferInsertModel<typeof idempotentRequests>;
export type SelectIdempotentRequest = InferSelectModel<typeof idempotentRequests>;
