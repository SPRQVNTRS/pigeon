/**
 * GET /v1/admin/dmarc/reports/:id
 *
 * Fetch a single DMARC report by its integer id, with nested records.
 *
 * Response:
 *   Full report object with records array.
 */

import type { Route } from './+types/api.v1.admin.dmarc.reports.$id';
import { eq } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { dmarcReports, dmarcRecords } from '#drizzle/schema/index';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DmarcReportDetailRoute');

export async function loader({ params }: Route.LoaderArgs) {
  const idParam = params.id;
  const id = idParam ? parseInt(idParam, 10) : NaN;

  if (isNaN(id) || id < 1) {
    return Response.json({ error: 'Invalid report id' }, { status: 400 });
  }

  try {
    const [report] = await db
      .select()
      .from(dmarcReports)
      .where(eq(dmarcReports.id, id))
      .limit(1);

    if (!report) {
      return Response.json({ error: 'Report not found' }, { status: 404 });
    }

    const records = await db
      .select()
      .from(dmarcRecords)
      .where(eq(dmarcRecords.dmarcReportId, id));

    return Response.json({
      id: report.id,
      reportId: report.reportId,
      orgName: report.orgName,
      email: report.orgEmail,
      dateRangeBegin: report.dateRangeBegin?.toISOString() ?? null,
      dateRangeEnd: report.dateRangeEnd?.toISOString() ?? null,
      policyDomain: report.policyDomain,
      policyP: report.policyP,
      policyAdkim: report.policyAdkim,
      policyAspf: report.policyAspf,
      policySp: report.policySp,
      policyPct: report.policyPct,
      sourceMessageId: report.sourceMessageId,
      createdAt: report.receivedAt?.toISOString() ?? null,
      records: records.map((r) => ({
        id: r.id,
        sourceIp: r.sourceIp,
        count: r.count,
        disposition: r.disposition,
        dkimEval: r.dkimEval,
        spfEval: r.spfEval,
        headerFrom: r.headerFrom,
        spfAuthResults: r.spfAuthResults,
        dkimAuthResults: r.dkimAuthResults,
        createdAt: r.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to fetch DMARC report', { error, id });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
