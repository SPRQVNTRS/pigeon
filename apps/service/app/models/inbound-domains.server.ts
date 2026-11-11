import { and, asc, eq, inArray } from 'drizzle-orm';
import { inboundDomains, type SelectInboundDomain } from '#drizzle/schema/index';
import { db as defaultDb } from '#drizzle/db';
import type { Database, Executor } from '#app/lib/db-types';

export type { SelectInboundDomain as InboundDomain };

/** List an app's inbound domains, oldest first. */
export async function listInboundDomains(opts: { appId: string; db?: Database }): Promise<SelectInboundDomain[]> {
  const { appId, db = defaultDb } = opts;
  return db
    .select()
    .from(inboundDomains)
    .where(eq(inboundDomains.appId, appId))
    .orderBy(asc(inboundDomains.createdAt));
}

/**
 * Add an inbound domain to an app. `name` must already be normalised (lower
 * case). Throws the driver's unique violation when any app has the name.
 * A configuration write: run it inside withConfigChange and pass its
 * transaction as `db`.
 */
export async function createInboundDomain(opts: {
  appId: string;
  name: string;
  db?: Executor;
}): Promise<SelectInboundDomain> {
  const { appId, name, db = defaultDb } = opts;
  const [row] = await db.insert(inboundDomains).values({ appId, name }).returning();
  if (!row) throw new Error('Failed to create inbound domain');
  return row;
}

/** Get one inbound domain of an app by name. */
export async function getInboundDomainByName(opts: {
  appId: string;
  name: string;
  db?: Database;
}): Promise<SelectInboundDomain | null> {
  const { appId, name, db = defaultDb } = opts;
  const [row] = await db
    .select()
    .from(inboundDomains)
    .where(and(eq(inboundDomains.appId, appId), eq(inboundDomains.name, name)))
    .limit(1);
  return row ?? null;
}

/**
 * Routing lookup for the SNS inbound route: which app owns these recipient
 * domains? This is the one deliberate cross-app read (like the SES event
 * worker finding an email by SES message id): the notification arrives with
 * no app, and the domain name is what selects it. Each returned row carries
 * its appId, and everything downstream is scoped by it.
 */
export async function findEnabledInboundDomainsByNames(opts: {
  names: readonly string[];
  db?: Database;
}): Promise<SelectInboundDomain[]> {
  const { names, db = defaultDb } = opts;
  if (names.length === 0) return [];
  return db
    .select()
    .from(inboundDomains)
    .where(and(inArray(inboundDomains.name, [...names]), eq(inboundDomains.enabled, true)));
}
