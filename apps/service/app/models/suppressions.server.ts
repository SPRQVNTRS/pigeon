import { eq, and, inArray } from 'drizzle-orm';
import { suppressions } from '#drizzle/schema/index';
import type { SelectSuppression } from '#drizzle/schema/index';
import { db } from '#drizzle/db';

export type { SelectSuppression as Suppression };

export interface RecipientAvailability {
  available: string[];
  suppressed: string[];
}

/**
 * Add an email address to the suppression list for an app.
 */
export async function addSuppression(data: {
  appId: string;
  email: string;
  reason: string;
  sourceEmailId?: string;
}): Promise<SelectSuppression> {
  const [suppression] = await db
    .insert(suppressions)
    .values({
      appId: data.appId,
      email: data.email,
      reason: data.reason,
      sourceEmailId: data.sourceEmailId,
    })
    .onConflictDoNothing()
    .returning();

  if (!suppression) {
    // Already suppressed — fetch existing record
    const [existing] = await db
      .select()
      .from(suppressions)
      .where(and(eq(suppressions.appId, data.appId), eq(suppressions.email, data.email)))
      .limit(1);

    if (!existing) {
      throw new Error('Failed to add suppression');
    }

    return existing;
  }

  return suppression;
}

/**
 * Check if an email address is suppressed for an app.
 */
export async function isSuppressed(appId: string, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.appId, appId), eq(suppressions.email, email)))
    .limit(1);

  return row !== undefined;
}

/**
 * Filter a list of recipients against the suppression list in one query.
 * Returns available addresses (safe to send) and suppressed addresses (must skip).
 */
export async function checkRecipientAvailability({
  appId,
  recipients,
}: {
  appId: string;
  recipients: string[];
}): Promise<RecipientAvailability> {
  if (recipients.length === 0) {
    return { available: [], suppressed: [] };
  }

  const suppressedRows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(and(eq(suppressions.appId, appId), inArray(suppressions.email, recipients)));

  const suppressedSet = new Set(suppressedRows.map((r) => r.email.toLowerCase()));

  return {
    available: recipients.filter((r) => !suppressedSet.has(r.toLowerCase())),
    suppressed: recipients.filter((r) => suppressedSet.has(r.toLowerCase())),
  };
}

/**
 * List all suppressions for an app.
 */
export async function listSuppressions(appId: string): Promise<SelectSuppression[]> {
  return db.select().from(suppressions).where(eq(suppressions.appId, appId));
}

/**
 * Remove a suppression for an app+email.
 */
export async function removeSuppression(appId: string, email: string): Promise<void> {
  await db
    .delete(suppressions)
    .where(and(eq(suppressions.appId, appId), eq(suppressions.email, email)));
}
