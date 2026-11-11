import { and, desc, eq, lt } from 'drizzle-orm';
import { inboundEmails, type InsertInboundEmail, type SelectInboundEmail } from '#drizzle/schema/index';
import { db as defaultDb } from '#drizzle/db';
import type { Database } from '#app/lib/db-types';

export type { SelectInboundEmail as InboundEmail };

/**
 * Record one received mail for one inbound domain. Returns null when the row
 * exists already (SNS delivers at least once; the unique key is
 * ses_message_id + inbound_domain_id), so only the first delivery is processed.
 */
export async function insertInboundEmail(opts: {
  values: Omit<InsertInboundEmail, 'id' | 'createdAt'>;
  db?: Database;
}): Promise<SelectInboundEmail | null> {
  const { values, db = defaultDb } = opts;
  const [row] = await db
    .insert(inboundEmails)
    .values(values)
    .onConflictDoNothing({ target: [inboundEmails.sesMessageId, inboundEmails.inboundDomainId] })
    .returning();
  return row ?? null;
}

/** Get one inbound email of an app. */
export async function getInboundEmail(opts: {
  appId: string;
  id: string;
  db?: Database;
}): Promise<SelectInboundEmail | null> {
  const { appId, id, db = defaultDb } = opts;
  const [row] = await db
    .select()
    .from(inboundEmails)
    .where(and(eq(inboundEmails.id, id), eq(inboundEmails.appId, appId)))
    .limit(1);
  return row ?? null;
}

/**
 * Store the keyed sender hash (app/lib/inbound/sender-hash.ts) on one inbound
 * email of an app. Returns null when the row is gone (retention, or an erase
 * that ran while the mail was being processed).
 */
export async function setInboundSenderHash(opts: {
  appId: string;
  id: string;
  senderHash: string;
  db?: Database;
}): Promise<{ id: string } | null> {
  const { appId, id, senderHash, db = defaultDb } = opts;
  const [row] = await db
    .update(inboundEmails)
    .set({ senderHash })
    .where(and(eq(inboundEmails.id, id), eq(inboundEmails.appId, appId)))
    .returning({ id: inboundEmails.id });
  return row ?? null;
}

/** Delete one inbound email of an app (used to undo an insert whose job could not be queued). */
export async function deleteInboundEmail(opts: { appId: string; id: string; db?: Database }): Promise<void> {
  const { appId, id, db = defaultDb } = opts;
  await db.delete(inboundEmails).where(and(eq(inboundEmails.id, id), eq(inboundEmails.appId, appId)));
}

export interface InboundEmailSummary {
  id: string;
  inboundDomainId: string;
  receivedAt: Date;
  recipientCount: number;
  createdAt: Date;
}

/** Newest first. Ids, times and counts only: never an address. */
export async function listInboundEmails(opts: {
  appId: string;
  limit: number;
  db?: Database;
}): Promise<InboundEmailSummary[]> {
  const { appId, limit, db = defaultDb } = opts;
  return db
    .select({
      id: inboundEmails.id,
      inboundDomainId: inboundEmails.inboundDomainId,
      receivedAt: inboundEmails.receivedAt,
      recipientCount: inboundEmails.recipientCount,
      createdAt: inboundEmails.createdAt,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.appId, appId))
    .orderBy(desc(inboundEmails.createdAt))
    .limit(limit);
}

/**
 * Retention: delete every row (all apps) created before the cutoff. A
 * system-wide maintenance pass like idempotency-cleanup, so it is not scoped
 * to one app. Returns the number of rows deleted.
 */
export async function deleteInboundEmailsCreatedBefore(opts: {
  cutoff: Date;
  db?: Database;
}): Promise<number> {
  const { cutoff, db = defaultDb } = opts;
  const deleted = await db
    .delete(inboundEmails)
    .where(lt(inboundEmails.createdAt, cutoff))
    .returning({ id: inboundEmails.id });
  return deleted.length;
}
