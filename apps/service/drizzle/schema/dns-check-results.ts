import { createId } from '@paralleldrive/cuid2';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { domains } from './domains';

// =============================================================================
// DNS Check Results
// =============================================================================

export const dnsCheckResults = pgTable(
  'dns_check_results',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    domainId: text('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    recordType: text('record_type').notNull(),
    status: text('status').notNull(),
    expected: text('expected').notNull(),
    actual: text('actual'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('dns_check_results_domain_id_record_type_checked_at_idx').on(
      table.domainId,
      table.recordType,
      table.checkedAt,
    ),
  ],
);

export type InsertDnsCheckResult = InferInsertModel<typeof dnsCheckResults>;
export type SelectDnsCheckResult = InferSelectModel<typeof dnsCheckResults>;
