import { db } from '#drizzle/db';
import { dnsCheckResults } from '#drizzle/schema/dns-check-results';
import type { DnsCheckResult } from './types';

/**
 * Persist a batch of DNS check results to the database.
 */
export async function persistDnsCheckResults(results: DnsCheckResult[]): Promise<void> {
  if (results.length === 0) return;

  await db.insert(dnsCheckResults).values(
    results.map((r) => ({
      domainId: r.domainId,
      domain: r.domain,
      recordType: r.recordType,
      status: r.status,
      expected: r.expected,
      actual: r.actual ?? null,
      checkedAt: r.checkedAt,
    })),
  );
}
