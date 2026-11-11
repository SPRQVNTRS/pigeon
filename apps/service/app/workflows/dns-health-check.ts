/**
 * DNS Health Check Workflow
 *
 * Orchestrates DNS health verification for all verified pigeon domains.
 * Used by both the cron-scheduled task (every 4h) and the ad-hoc one-off
 * check triggered from the admin UI.
 *
 * The cron path goes through the ScheduledTask system (tasks.ts + handler).
 * The ad-hoc path is registered directly via boss.work() in server.ts.
 */

import { eq } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { domains } from '#drizzle/schema/index';
import { verifyDkimCname, verifySPF, verifyDMARC, verifySESStatus } from '#app/lib/dns-health/verifiers';
import { persistDnsCheckResults } from '#app/lib/dns-health/persist';
import type { DnsCheckResult, DnsHealthRecordType } from '#app/lib/dns-health/types';
import { createComponentLogger } from '#app/lib/logger';
import type { PgBoss } from '@sprqvntrs/workflows';

const log = createComponentLogger('DnsHealthCheck');

const ADHOC_QUEUE = 'dns-health-check-adhoc';

// ---------------------------------------------------------------------------
// Shared orchestration — used by cron handler AND ad-hoc worker
// ---------------------------------------------------------------------------

type DkimRecordType = 'dkim_cname_1' | 'dkim_cname_2' | 'dkim_cname_3';
const DKIM_RECORD_TYPES: DkimRecordType[] = ['dkim_cname_1', 'dkim_cname_2', 'dkim_cname_3'];

/**
 * Run all DNS checks for a single domain.
 * Fetches the domain from DB, calls all 4 verifiers in parallel via
 * Promise.allSettled, persists results, and returns them.
 */
export async function runDnsCheckForDomain(domainId: string): Promise<DnsCheckResult[]> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) throw new Error(`Domain not found: ${domainId}`);

  const tokens = domain.dkimTokens ?? [];

  const dkimChecks = tokens.slice(0, 3).map((token, i) => {
    const recordType = DKIM_RECORD_TYPES[i]!;
    return verifyDkimCname(domain.id, domain.name, token, recordType, domain.region ?? undefined);
  });

  const verifierPromises = [
    ...dkimChecks,
    verifySPF(domain.id, domain.name, domain.region ?? undefined),
    verifyDMARC(domain.id, domain.name, domain.region ?? undefined),
    verifySESStatus(domain.id, domain.name, domain.region ?? undefined),
  ];

  const settled = await Promise.allSettled(verifierPromises);

  const errorTypes: DnsHealthRecordType[] = [
    'dkim_cname_1',
    'dkim_cname_2',
    'dkim_cname_3',
    'spf_txt',
    'dmarc_txt',
    'ses_verified',
  ];

  const results: DnsCheckResult[] = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') return outcome.value;

    const err = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    log.error('Verifier threw unexpectedly', { domainId, index: i, error: err });

    const recordType = errorTypes[i] ?? 'ses_verified';
    return {
      domainId: domain.id,
      domain: domain.name,
      recordType,
      status: 'error',
      expected: '',
      actual: err,
      checkedAt: new Date(),
    };
  });

  await persistDnsCheckResults(results);
  return results;
}

// ---------------------------------------------------------------------------
// Ad-hoc enqueue + status polling (used by the admin UI)
// ---------------------------------------------------------------------------

/**
 * Enqueue a one-off DNS check job for a domain.
 * Returns the pg-boss job ID immediately; the caller polls for completion.
 */
export async function enqueueDnsCheck(boss: PgBoss, domainId: string): Promise<string> {
  const jobId = await boss.send(ADHOC_QUEUE, { domainId }, { retryLimit: 0 });
  if (!jobId) throw new Error('Failed to enqueue dns-health-check-adhoc job');
  return jobId;
}

/**
 * Map a pg-boss job state to a simplified status string.
 */
export async function getDnsCheckJobStatus(
  boss: PgBoss,
  jobId: string,
): Promise<'queued' | 'running' | 'completed' | 'failed' | 'not_found'> {
  const job = await boss.getJobById(ADHOC_QUEUE, jobId);
  if (!job) return 'not_found';

  switch (job.state) {
    case 'created':
    case 'retry':
      return 'queued';
    case 'active':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'failed':
    default:
      return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Ad-hoc worker registration
// ---------------------------------------------------------------------------

interface DnsHealthAdhocJob {
  data: { domainId: string };
}

/**
 * Register the dns-health-check-adhoc worker with pg-boss.
 * Called from server.ts alongside the other register*Worker calls.
 */
export async function registerDnsHealthCheckAdhocWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(ADHOC_QUEUE);
  boss.work(
    ADHOC_QUEUE,
    { batchSize: 1 },
    async (jobs: DnsHealthAdhocJob[]) => {
      const job = jobs[0];
      if (!job) return;
      try {
        await runDnsCheckForDomain(job.data.domainId);
        log.info('Ad-hoc DNS check complete', { domainId: job.data.domainId });
      } catch (err) {
        log.error('Ad-hoc DNS check failed', {
          domainId: job.data.domainId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // pg-boss marks as failed
      }
    },
  );
  log.info(`${ADHOC_QUEUE} worker registered`);
}
