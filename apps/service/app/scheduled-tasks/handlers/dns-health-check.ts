/**
 * DNS Health Check Handler
 *
 * Iterates all verified domains, runs DNS health checks for each,
 * and prunes dns_check_results rows older than 30 days.
 *
 * Runs every 4 hours via the ScheduledTask system.
 */

import { isNotNull, lt } from 'drizzle-orm';
import type { ScheduledTaskHandler, ScheduledTaskResult } from '../types';
import { createComponentLogger } from '#app/lib/logger';
import { db } from '#drizzle/db';
import { domains } from '#drizzle/schema/index';
import { dnsCheckResults } from '#drizzle/schema/dns-check-results';
import { runDnsCheckForDomain } from '#app/workflows/dns-health-check';

const log = createComponentLogger('DnsHealthCheck');

interface DnsHealthCheckResult {
  checked: number;
  pass: number;
  fail: number;
  errors: number;
  pruned: number;
}

/**
 * Run DNS health checks for all verified domains, then prune stale rows.
 */
export const dnsHealthCheckHandler: ScheduledTaskHandler<
  Record<string, unknown>,
  DnsHealthCheckResult
> = async (): Promise<ScheduledTaskResult<DnsHealthCheckResult>> => {
  const verifiedDomains = await db
    .select({ id: domains.id })
    .from(domains)
    .where(isNotNull(domains.verifiedAt));

  let pass = 0;
  let fail = 0;
  let errors = 0;

  for (const domain of verifiedDomains) {
    try {
      const results = await runDnsCheckForDomain(domain.id);
      pass += results.filter((r) => r.status === 'pass').length;
      fail += results.filter((r) => r.status === 'fail').length;
      errors += results.filter((r) => r.status === 'error').length;
    } catch (err) {
      log.error('Domain check failed', {
        domainId: domain.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let pruned = 0;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(dnsCheckResults)
      .where(lt(dnsCheckResults.checkedAt, cutoff))
      .returning({ id: dnsCheckResults.id });
    pruned = deleted.length;
    log.debug('Pruned old dns_check_results', { pruned, cutoff });
  } catch (err) {
    log.warn('Failed to prune dns_check_results', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('[dns-health] check complete', {
    checked: verifiedDomains.length,
    pass,
    fail,
    errors,
    pruned,
  });

  return {
    status: 'completed',
    message: `checked ${verifiedDomains.length} domains: ${pass} pass, ${fail} fail, ${errors} error`,
    data: { checked: verifiedDomains.length, pass, fail, errors, pruned },
  };
};
