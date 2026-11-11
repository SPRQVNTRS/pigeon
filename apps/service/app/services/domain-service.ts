/**
 * Domain Service
 *
 * Orchestrates domain lifecycle: create, list, get, delete, and verification
 * scheduling.  All SES calls go through the ses/identity wrapper.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { domains, type InsertDomain, type SelectDomain } from '#drizzle/schema';
import { createIdentity, deleteIdentity, buildDnsRecords } from '#app/lib/ses';
import type { DnsRecord } from '#app/lib/ses';
import { CONFIG } from '#config';
import { createComponentLogger } from '#app/lib/logger';
import type { Executor } from '#app/lib/db-types';
import { ConfigItemNotFoundError } from '#app/lib/state-version';
import { withConfigChange } from '#app/models/config-change.server';

const log = createComponentLogger('DomainService');

/**
 * Minimal pg-boss interface required by this module.
 * Compatible with both pg-boss@10 (used by @sprqvntrs/workflows) and pg-boss@12.
 */
export interface BossClient {
  send(
    name: string,
    data: object,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
}

export interface CreateDomainOptions {
  appId: string;
  name: string;
  region?: string;
  /** The If-Match state version, or null for an unconditional write. */
  expectedVersion: number | null;
}

export interface DomainWithDnsRecords {
  domain: SelectDomain;
  dnsRecords: DnsRecord[];
  /** The app's state version after this write. */
  stateVersion: number;
}

/**
 * Create a new domain identity in SES and persist the row.
 * Enqueues a domain.verify job for async DNS verification.
 *
 * Order (see withConfigChange): the state version check and the app row lock
 * come first, then the SES identity, then the row, then commit. A version
 * mismatch therefore throws before SES is called. If SES fails, the
 * transaction rolls back and nothing changed. If the insert or the commit
 * fails after SES succeeded, the SES identity is left without a row (the same
 * gap as before this order existed); registering the name again repairs it.
 * The verify job is queued after commit, so the worker never looks for a row
 * that is not visible yet.
 */
export async function createDomain({
  appId,
  name,
  region = CONFIG.aws.region,
  expectedVersion,
  boss,
}: CreateDomainOptions & { boss: BossClient }): Promise<DomainWithDnsRecords> {
  log.info('Creating domain identity', { appId, name, region });

  const { result: row, stateVersion } = await withConfigChange({
    appId,
    expectedVersion,
    run: async (tx) => {
      const { dkimTokens } = await createIdentity({ domain: name, region });
      const [inserted] = await tx
        .insert(domains)
        .values({
          appId,
          name,
          region,
          dkimTokens,
          spfStatus: 'pending',
          dkimStatus: 'pending',
          dmarcStatus: 'pending',
          mxStatus: 'pending',
        } satisfies Omit<InsertDomain, 'id' | 'createdAt' | 'updatedAt'>)
        .returning();
      if (!inserted) throw new Error('Failed to insert domain row');
      return inserted;
    },
  });

  await enqueueVerification({ domainId: row.id, boss });

  const dnsRecords = buildDnsRecords({ domain: name, region, dkimTokens: row.dkimTokens ?? [] });

  log.info('Domain created', { domainId: row.id, name });
  return { domain: row, dnsRecords, stateVersion };
}

/**
 * List all domains belonging to an app.
 */
export async function listDomains(appId: string): Promise<SelectDomain[]> {
  return db.select().from(domains).where(eq(domains.appId, appId));
}

/**
 * Get a single domain by ID, scoped to the given app.
 * Returns null if not found or if it belongs to a different app.
 */
export async function getDomain({
  domainId,
  appId,
  executor = db,
}: {
  domainId: string;
  appId: string;
  executor?: Executor;
}): Promise<SelectDomain | null> {
  const [row] = await executor
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.appId, appId)));
  return row ?? null;
}

/**
 * Delete a domain: removes the row and the SES identity. Returns the app's
 * state version after the write. Throws ConfigItemNotFoundError when the app
 * has no such domain, and StateVersionMismatchError on a stale expectedVersion.
 *
 * Order: version check and app row lock, then the row delete, then the SES
 * delete, then commit. A mismatch throws before SES is called. If SES fails,
 * the row delete rolls back and nothing changed. If the commit fails after SES
 * succeeded, the row stays without its identity; deleting it again repairs it.
 */
export async function deleteDomain({
  domainId,
  appId,
  expectedVersion,
}: {
  domainId: string;
  appId: string;
  expectedVersion: number | null;
}): Promise<{ stateVersion: number }> {
  const { result: domain, stateVersion } = await withConfigChange({
    appId,
    expectedVersion,
    run: async (tx) => {
      const found = await getDomain({ domainId, appId, executor: tx });
      if (!found) throw new ConfigItemNotFoundError('Domain');

      log.info('Deleting domain', { domainId, name: found.name });
      await tx.delete(domains).where(and(eq(domains.id, domainId), eq(domains.appId, appId)));
      await deleteIdentity({ domain: found.name, region: found.region ?? CONFIG.aws.region });
      return found;
    },
  });

  log.info('Domain deleted', { domainId, name: domain.name });
  return { stateVersion };
}

/**
 * Enqueue a domain.verify job with exponential backoff (~24h coverage).
 * singletonKey prevents fan-out if called multiple times.
 */
export async function enqueueVerification({
  domainId,
  boss,
}: {
  domainId: string;
  boss: BossClient;
}): Promise<void> {
  await boss.send('domain.verify', { domainId }, {
    singletonKey: domainId,
    retryLimit: 14,
    retryDelay: 60,
    retryBackoff: true,
  });

  log.debug('Enqueued domain.verify job', { domainId });
}
