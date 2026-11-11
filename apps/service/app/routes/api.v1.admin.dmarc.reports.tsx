/**
 * GET /v1/admin/dmarc/reports
 *
 * Paginated list of DMARC aggregate reports.
 *
 * Query parameters:
 *   cursor  — last id seen (integer); omit for first page
 *   limit   — default 50, max 200
 *   domain  — filter by policy_domain
 *
 * Response:
 *   { reports: [...], nextCursor: number | null }
 */

import type { Route } from './+types/api.v1.admin.dmarc.reports';
import { desc, lt, eq, and, sql } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { dmarcReports, dmarcRecords } from '#drizzle/schema/index';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DmarcReportsListRoute');

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const cursorParam = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const domain = url.searchParams.get('domain');

  const cursor = cursorParam ? parseInt(cursorParam, 10) : null;
  const limit = Math.min(Math.max(parseInt(limitParam ?? '50', 10) || 50, 1), 200);

  if (cursor !== null && (isNaN(cursor) || cursor < 1)) {
    return Response.json({ error: 'Invalid cursor' }, { status: 400 });
  }

  try {
    // Build WHERE conditions
    const conditions = [];
    if (cursor !== null) {
      conditions.push(lt(dmarcReports.id, cursor));
    }
    if (domain) {
      conditions.push(eq(dmarcReports.policyDomain, domain));
    }

    // Subquery for record count per report
    const recordCountSq = db
      .select({
        dmarcReportId: dmarcRecords.dmarcReportId,
        count: sql<number>`cast(count(*) as integer)`.as('count'),
      })
      .from(dmarcRecords)
      .groupBy(dmarcRecords.dmarcReportId)
      .as('record_counts');

    const rows = await db
      .select({
        id: dmarcReports.id,
        reportId: dmarcReports.reportId,
        orgName: dmarcReports.orgName,
        orgEmail: dmarcReports.orgEmail,
        dateRangeBegin: dmarcReports.dateRangeBegin,
        dateRangeEnd: dmarcReports.dateRangeEnd,
        policyDomain: dmarcReports.policyDomain,
        policyP: dmarcReports.policyP,
        receivedAt: dmarcReports.receivedAt,
        recordCount: sql<number>`coalesce(${recordCountSq.count}, 0)`,
      })
      .from(dmarcReports)
      .leftJoin(recordCountSq, eq(dmarcReports.id, recordCountSq.dmarcReportId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(dmarcReports.id))
      .limit(limit);

    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;

    const reports = rows.map((r) => ({
      id: r.id,
      reportId: r.reportId,
      orgName: r.orgName,
      email: r.orgEmail,
      dateRangeBegin: r.dateRangeBegin?.toISOString() ?? null,
      dateRangeEnd: r.dateRangeEnd?.toISOString() ?? null,
      policyDomain: r.policyDomain,
      policyP: r.policyP,
      recordCount: r.recordCount ?? 0,
      createdAt: r.receivedAt?.toISOString() ?? null,
    }));

    return Response.json({ reports, nextCursor });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to list DMARC reports', { error });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
