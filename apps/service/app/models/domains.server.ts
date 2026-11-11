import { eq, and, count } from 'drizzle-orm';
import { domains } from '#drizzle/schema/index';
import type { InsertDomain, SelectDomain } from '#drizzle/schema/index';
import { db } from '#drizzle/db';

export type { SelectDomain as Domain };

/**
 * Count domains for an app.
 */
export async function countDomains(appId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(domains)
    .where(eq(domains.appId, appId));
  return row?.count ?? 0;
}

/**
 * Create a domain for an app.
 */
export async function createDomain(data: {
  appId: string;
  name: string;
  region?: string;
  dkimSelector?: string;
}): Promise<SelectDomain> {
  const [domain] = await db
    .insert(domains)
    .values({
      appId: data.appId,
      name: data.name,
      region: data.region,
      dkimSelector: data.dkimSelector,
    })
    .returning();

  if (!domain) {
    throw new Error('Failed to create domain');
  }

  return domain;
}

/**
 * Get a domain by ID, scoped to appId.
 */
export async function getDomain(id: string, appId: string): Promise<SelectDomain | null> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, id), eq(domains.appId, appId)))
    .limit(1);

  return domain ?? null;
}

/**
 * List domains for an app.
 */
export async function listDomains(appId: string): Promise<SelectDomain[]> {
  return db.select().from(domains).where(eq(domains.appId, appId));
}

/**
 * Update domain verification status fields.
 */
export async function updateDomainVerification(
  id: string,
  appId: string,
  data: Partial<
    Pick<
      SelectDomain,
      | 'spfStatus'
      | 'dkimStatus'
      | 'dmarcStatus'
      | 'mxStatus'
      | 'verifiedAt'
      | 'lastVerificationError'
      | 'dkimTokens'
    >
  >,
): Promise<SelectDomain> {
  const [domain] = await db
    .update(domains)
    .set(data)
    .where(and(eq(domains.id, id), eq(domains.appId, appId)))
    .returning();

  if (!domain) {
    throw new Error(`Domain ${id} not found or not owned by app ${appId}`);
  }

  return domain;
}

/**
 * Get a domain by hostname (name), scoped to appId.
 * Used by the email send route to verify the sender domain is allowed.
 */
export async function getDomainByHostname(hostname: string, appId: string): Promise<SelectDomain | null> {
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.name, hostname), eq(domains.appId, appId)))
    .limit(1);
  return domain ?? null;
}
