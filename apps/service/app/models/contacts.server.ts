import { eq, and, asc, desc, gt, isNull, notExists, sql } from 'drizzle-orm';
import { contacts, suppressions } from '#drizzle/schema/index';
import type { SelectContact } from '#drizzle/schema/index';
import { db } from '#drizzle/db';

export type { SelectContact as Contact };

/**
 * Thrown when a tenant asks to re-subscribe a contact that a bounce, a
 * complaint or a suppression-list entry has blocked. Nothing was changed.
 */
export class ContactSuppressedError extends Error {
  constructor() {
    super('Contact is suppressed and cannot be re-subscribed');
    this.name = 'ContactSuppressedError';
  }
}

/**
 * Upsert a contact (insert or update on audienceId+email conflict).
 */
export async function upsertContact(data: {
  appId: string;
  audienceId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown>;
}): Promise<SelectContact> {
  const [contact] = await db
    .insert(contacts)
    .values({
      appId: data.appId,
      audienceId: data.audienceId,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      attributes: data.attributes ?? {},
    })
    .onConflictDoUpdate({
      target: [contacts.audienceId, contacts.email],
      set: {
        firstName: data.firstName,
        lastName: data.lastName,
        attributes: data.attributes ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!contact) {
    throw new Error('Failed to upsert contact');
  }

  return contact;
}

/**
 * Get a contact by ID, scoped to appId.
 */
export async function getContact(id: string, appId: string): Promise<SelectContact | null> {
  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.appId, appId)))
    .limit(1);

  return contact ?? null;
}

/**
 * List contacts for an audience, scoped to appId.
 */
export async function listContacts(
  audienceId: string,
  appId: string,
  opts?: { limit?: number; offset?: number },
): Promise<SelectContact[]> {
  const { limit = 100, offset = 0 } = opts ?? {};

  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.audienceId, audienceId), eq(contacts.appId, appId)))
    .orderBy(desc(contacts.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * List one page of an audience in id order, scoped to appId. `after` is the id
 * of the last row of the previous page, null for the first page. The bound does
 * not need its row to still exist, so a contact removed during a read shifts
 * nothing. Ids are random, not time ordered: see the route for what that means
 * for a contact added during a read.
 */
export async function listContactsAfterId(opts: {
  audienceId: string;
  appId: string;
  limit: number;
  after: string | null;
}): Promise<SelectContact[]> {
  const { audienceId, appId, limit, after } = opts;
  const pastCursor = after === null ? undefined : gt(contacts.id, after);

  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.audienceId, audienceId), eq(contacts.appId, appId), pastCursor))
    .orderBy(asc(contacts.id))
    .limit(limit);
}

/**
 * Unsubscribe a contact by audienceId+email, scoped to appId.
 */
export async function unsubscribeContact(
  audienceId: string,
  email: string,
  appId: string,
): Promise<SelectContact | null> {
  const [contact] = await db
    .update(contacts)
    .set({ status: 'unsubscribed', unsubscribedAt: new Date() })
    .where(
      and(
        eq(contacts.audienceId, audienceId),
        eq(contacts.email, email),
        eq(contacts.appId, appId),
      ),
    )
    .returning();

  return contact ?? null;
}

/**
 * Update a contact's mutable fields, scoped to appId.
 *
 * `status: 'subscribed'` re-subscribes the contact: it sets the status and
 * clears `unsubscribedAt`. The same UPDATE refuses a contact with `bouncedAt`
 * or `complainedAt` set, or whose address is on the app's suppression list, so
 * a tenant can never undo a bounce or a complaint and a race with the SES
 * event path cannot slip through. Returns null when the contact does not
 * exist, throws ContactSuppressedError when it is blocked.
 */
export async function updateContact(
  id: string,
  appId: string,
  data: {
    firstName?: string;
    lastName?: string;
    attributes?: Record<string, unknown>;
    status?: 'subscribed';
  },
): Promise<SelectContact | null> {
  const { status, ...fields } = data;
  const isResubscribe = status === 'subscribed';
  const resubscribeFields = isResubscribe ? { status, unsubscribedAt: null } : {};
  const resubscribeGuards = isResubscribe
    ? [
        isNull(contacts.bouncedAt),
        isNull(contacts.complainedAt),
        notExists(
          // citext on both sides: the comparison is case-insensitive.
          db
            .select({ one: sql`1` })
            .from(suppressions)
            .where(and(eq(suppressions.appId, contacts.appId), eq(suppressions.email, contacts.email))),
        ),
      ]
    : [];

  const [contact] = await db
    .update(contacts)
    .set({ ...fields, ...resubscribeFields, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), eq(contacts.appId, appId), ...resubscribeGuards))
    .returning();
  if (contact) return contact;
  if (!isResubscribe) return null;

  // No row updated: either the contact is missing or a guard refused it.
  const existing = await getContact(id, appId);
  if (!existing) return null;
  throw new ContactSuppressedError();
}

/**
 * Bulk upsert contacts into an audience, scoped to appId.
 * On conflict (audienceId + email) updates name and attribute fields.
 */
export async function bulkUpsertContacts(
  appId: string,
  audienceId: string,
  items: Array<{ email: string; firstName?: string; lastName?: string; attributes?: Record<string, unknown> }>,
): Promise<SelectContact[]> {
  if (items.length === 0) return [];
  const rows = items.map((item) => ({
    appId,
    audienceId,
    email: item.email,
    firstName: item.firstName,
    lastName: item.lastName,
    attributes: item.attributes ?? {},
  }));
  return db
    .insert(contacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [contacts.audienceId, contacts.email],
      set: {
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        attributes: sql`excluded.attributes`,
        updatedAt: new Date(),
      },
    })
    .returning();
}
