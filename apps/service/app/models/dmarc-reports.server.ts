import { eq } from 'drizzle-orm';
import { dmarcRecords, dmarcReports } from '#drizzle/schema/index';
import { db as defaultDb } from '#drizzle/db';
import type { Database } from '#app/lib/db-types';
import type { StoreDmarcReportInput } from '#app/lib/dmarc/sns-dmarc';

/**
 * Store one parsed aggregate report: upsert dmarc_reports on report_id (a
 * re-delivery only updates source_message_id), then replace its dmarc_records.
 * One transaction, so a failed record insert leaves the old rows in place and
 * the SNS retry can store the report again.
 *
 * @throws on database errors
 */
export async function storeDmarcReport(opts: StoreDmarcReportInput & { db?: Database }): Promise<{ id: number }> {
  const { report, sourceS3Key, sourceMessageId, db = defaultDb } = opts;

  return db.transaction(async (tx) => {
    const [upserted] = await tx
      .insert(dmarcReports)
      .values({
        reportId: report.reportId,
        orgName: report.orgName,
        orgEmail: report.email ?? null,
        sourceS3Key,
        dateRangeBegin: new Date(report.dateRangeBegin * 1000),
        dateRangeEnd: new Date(report.dateRangeEnd * 1000),
        policyDomain: report.policyDomain,
        policyAdkim: report.policyAdkim ?? null,
        policyAspf: report.policyAspf ?? null,
        policyP: report.policyP ?? null,
        policySp: report.policySp ?? null,
        policyPct: report.policyPct ?? null,
        sourceMessageId,
      })
      .onConflictDoUpdate({ target: dmarcReports.reportId, set: { sourceMessageId } })
      .returning({ id: dmarcReports.id });

    if (!upserted) throw new Error('dmarc_reports upsert returned no row');

    await tx.delete(dmarcRecords).where(eq(dmarcRecords.dmarcReportId, upserted.id));

    if (report.records.length > 0) {
      await tx.insert(dmarcRecords).values(
        report.records.map((record) => ({
          dmarcReportId: upserted.id,
          sourceIp: record.sourceIp,
          count: record.count,
          disposition: record.disposition || null,
          dkimEval: record.dkimEval || null,
          spfEval: record.spfEval || null,
          headerFrom: record.headerFrom || null,
          spfAuthResults: record.spfAuthResults.length > 0 ? record.spfAuthResults : null,
          dkimAuthResults: record.dkimAuthResults.length > 0 ? record.dkimAuthResults : null,
        })),
      );
    }

    return { id: upserted.id };
  });
}
