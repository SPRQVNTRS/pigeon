import { eq, and, desc } from 'drizzle-orm';
import { emails } from '#drizzle/schema/index';
import type { InsertEmail, SelectEmail } from '#drizzle/schema/index';
import { db } from '#drizzle/db';
import { BLANKED_EMAIL_BODY } from '#app/lib/blank-email-body';

export type { SelectEmail as Email };

/**
 * Create a new email record.
 */
export async function createEmail(data: InsertEmail): Promise<SelectEmail> {
  const [email] = await db.insert(emails).values(data).returning();

  if (!email) {
    throw new Error('Failed to create email');
  }

  return email;
}

/**
 * Get an email by ID, scoped to appId.
 */
export async function getEmail(id: string, appId: string): Promise<SelectEmail | null> {
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), eq(emails.appId, appId)))
    .limit(1);

  return email ?? null;
}

/**
 * List emails for an app with optional pagination.
 */
export async function listEmails(
  appId: string,
  opts?: { limit?: number; offset?: number },
): Promise<SelectEmail[]> {
  const { limit = 50, offset = 0 } = opts ?? {};

  return db
    .select()
    .from(emails)
    .where(eq(emails.appId, appId))
    .orderBy(desc(emails.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Update email status with optional extra fields (sentAt, failureReason, etc.).
 */
export async function updateEmailStatus(
  id: string,
  appId: string,
  status: string,
  extra?: Partial<
    Pick<SelectEmail, 'sentAt' | 'deliveredAt' | 'failureReason' | 'messageId'>
  >,
): Promise<SelectEmail> {
  const [email] = await db
    .update(emails)
    .set({ status, ...extra })
    .where(and(eq(emails.id, id), eq(emails.appId, appId)))
    .returning();

  if (!email) {
    throw new Error(`Email ${id} not found or not owned by app ${appId}`);
  }

  return email;
}

/**
 * Blank html, text and headers of one email, scoped to appId.
 *
 * Unlike updateEmailStatus this does not throw when the row is gone: the
 * caller wants the body gone, and a row that no longer exists already is.
 * Returns whether a row was changed.
 */
export async function blankEmailBody(id: string, appId: string): Promise<boolean> {
  const blanked = await db
    .update(emails)
    .set({ ...BLANKED_EMAIL_BODY })
    .where(and(eq(emails.id, id), eq(emails.appId, appId)))
    .returning({ id: emails.id });

  return blanked.length > 0;
}
