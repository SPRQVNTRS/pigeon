import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  customType,
} from 'drizzle-orm/pg-core';

const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

export const dmarcReports = pgTable(
  'dmarc_reports',
  {
    id: serial('id').primaryKey(),
    reportId: text('report_id').notNull().unique(),
    orgName: text('org_name').notNull(),
    orgEmail: text('org_email'),
    extraContactInfo: text('extra_contact_info'),
    sourceS3Key: text('source_s3_key').notNull().default(''),
    dateRangeBegin: timestamp('date_range_begin', { withTimezone: true }).notNull(),
    dateRangeEnd: timestamp('date_range_end', { withTimezone: true }).notNull(),
    policyDomain: text('policy_domain').notNull(),
    policyAdkim: text('policy_adkim'),
    policyAspf: text('policy_aspf'),
    policyP: text('policy_p'),
    policySp: text('policy_sp'),
    policyPct: integer('policy_pct'),
    sourceMessageId: text('source_message_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).default(sql`now()`),
  },
  (table) => [
    index('dmarc_reports_policy_domain_idx').on(table.policyDomain),
    index('dmarc_reports_date_range_begin_idx').on(table.dateRangeBegin),
    index('dmarc_reports_received_at_idx').on(table.receivedAt),
  ],
);

export type InsertDmarcReport = InferInsertModel<typeof dmarcReports>;
export type SelectDmarcReport = InferSelectModel<typeof dmarcReports>;

export const dmarcRecords = pgTable(
  'dmarc_records',
  {
    id: serial('id').primaryKey(),
    dmarcReportId: integer('dmarc_report_id')
      .notNull()
      .references(() => dmarcReports.id, { onDelete: 'cascade' }),
    sourceIp: inet('source_ip').notNull(),
    count: integer('count').notNull(),
    disposition: text('disposition'),
    dkimEval: text('dkim_eval'),
    spfEval: text('spf_eval'),
    headerFrom: text('header_from'),
    envelopeFrom: text('envelope_from'),
    envelopeTo: text('envelope_to'),
    policyReasons: jsonb('policy_reasons'),
    spfAuthResults: jsonb('spf_auth_results'),
    dkimAuthResults: jsonb('dkim_auth_results'),
    createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  },
  (table) => [
    index('dmarc_records_dmarc_report_id_idx').on(table.dmarcReportId),
    index('dmarc_records_source_ip_idx').on(table.sourceIp),
    index('dmarc_records_header_from_idx').on(table.headerFrom),
  ],
);

export type InsertDmarcRecord = InferInsertModel<typeof dmarcRecords>;
export type SelectDmarcRecord = InferSelectModel<typeof dmarcRecords>;
