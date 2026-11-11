/**
 * domain.verify worker
 *
 * Polls GetEmailIdentity for the domain, updates status columns in the DB,
 * and transitions the domain to verified or failed.
 *
 * Registered via boss.work() — not via the workflow orchestrator — because
 * domain verification is a simple retry loop, not a multi-stage workflow.
 *
 * Uses a duck-typed BossWorker interface so this module is compatible with
 * both pg-boss@10 (used by @sprqvntrs/workflows) and pg-boss@12.
 */

import { eq } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { domains } from '#drizzle/schema';
import { getIdentity } from '#app/lib/ses';
import { CONFIG } from '#config';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('DomainVerifyWorker');

interface DomainVerifyPayload {
  domainId: string;
}

interface DomainVerifyJob {
  data: DomainVerifyPayload;
}

/**
 * Minimal interface for a pg-boss instance that supports work().
 * Compatible with pg-boss@10 and @12.
 */
export interface BossWorker {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    options: { batchSize: number },
    handler: (jobs: DomainVerifyJob[]) => Promise<void>,
  ): unknown;
}

/**
 * Register the domain.verify worker with the given pg-boss instance.
 * Creates the queue first (idempotent — pg-boss uses ON CONFLICT DO NOTHING).
 */
export async function registerDomainVerifyWorker(boss: BossWorker): Promise<void> {
  await boss.createQueue('domain.verify');
  boss.work('domain.verify', { batchSize: 1 }, handleDomainVerify);
  log.info('domain.verify worker registered');
}

async function handleDomainVerify(jobs: DomainVerifyJob[]): Promise<void> {
  const job = jobs[0];
  if (!job) return;

  const { domainId } = job.data;

  // Load domain from DB
  const [domain] = await db
    .select()
    .from(domains)
    .where(eq(domains.id, domainId));

  if (!domain) {
    log.warn('domain.verify: domain not found, skipping', { domainId });
    return;
  }

  log.info('Checking domain verification status', { domainId, name: domain.name });

  const region = domain.region ?? CONFIG.aws.region;

  let identity;
  try {
    identity = await getIdentity({ domain: domain.name, region });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to get SES identity', { domainId, error });
    await db
      .update(domains)
      .set({ lastVerificationError: error.message })
      .where(eq(domains.id, domainId));
    throw err; // let pg-boss retry
  }

  const dkimVerified = identity.dkim.status === 'SUCCESS';
  const fullyVerified = dkimVerified && identity.verifiedForSending;

  const dkimStatus = dkimVerified ? 'verified' : 'pending';

  await db
    .update(domains)
    .set({
      dkimStatus,
      spfStatus: fullyVerified ? 'verified' : domain.spfStatus,
      dmarcStatus: fullyVerified ? 'verified' : domain.dmarcStatus,
      mxStatus: fullyVerified ? 'verified' : domain.mxStatus,
      verifiedAt: fullyVerified ? new Date() : domain.verifiedAt,
      lastVerificationError: null,
    })
    .where(eq(domains.id, domainId));

  if (fullyVerified) {
    log.info('Domain verified', { domainId, name: domain.name });
    // TODO(spec-06): emit outbound webhook on status change
  } else {
    log.debug('Domain not yet verified, will retry', {
      domainId,
      name: domain.name,
      dkimStatus: identity.dkim.status,
      verifiedForSending: identity.verifiedForSending,
    });
    // Throw to trigger pg-boss retry
    throw new Error(`Domain ${domain.name} not yet verified, dkim: ${identity.dkim.status}`);
  }
}
