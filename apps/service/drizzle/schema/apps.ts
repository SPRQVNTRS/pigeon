import { createId } from '@paralleldrive/cuid2';
import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// =============================================================================
// Apps
// =============================================================================

export const apps = pgTable(
  'apps',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    /**
     * Unique (apps_name_idx): two concurrent creates of one name end with one
     * app and a unique violation, which createApp maps to AppNameTakenError.
     */
    name: text('name').notNull(),
    /**
     * Mail retention, per app. NULL means keep forever (the behaviour before
     * retention existed), so no product loses mail unless it opts in.
     *
     * - body: after this many days the daily retention task blanks html, text
     *   and headers on the app's emails rows.
     * - row: after this many days it deletes the emails row and its events.
     */
    mailBodyRetentionDays: integer('mail_body_retention_days'),
    mailRowRetentionDays: integer('mail_row_retention_days'),
    /**
     * Counts changes to the app's configuration: domains, audiences, webhooks
     * and inbound domains. Every such write bumps it in the same transaction
     * (app/models/config-change.server.ts), and a client may send it back in
     * If-Match to refuse a write on a stale view. See docs/concurrency.md.
     */
    stateVersion: integer('state_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('apps_name_idx').on(table.name),
    check(
      'apps_mail_body_retention_days_positive',
      sql`${table.mailBodyRetentionDays} IS NULL OR ${table.mailBodyRetentionDays} > 0`,
    ),
    check(
      'apps_mail_row_retention_days_positive',
      sql`${table.mailRowRetentionDays} IS NULL OR ${table.mailRowRetentionDays} > 0`,
    ),
  ],
);

export type InsertApp = InferInsertModel<typeof apps>;
export type SelectApp = InferSelectModel<typeof apps>;
