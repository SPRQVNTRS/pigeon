import { eq, and, count } from 'drizzle-orm';
import { audiences } from '#drizzle/schema/index';
import type { SelectAudience } from '#drizzle/schema/index';
import { db } from '#drizzle/db';
import type { Executor } from '#app/lib/db-types';
import { ConfigItemNotFoundError } from '#app/lib/state-version';

export type { SelectAudience as Audience };

/**
 * Count audiences for an app.
 */
export async function countAudiences(appId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(audiences)
    .where(eq(audiences.appId, appId));
  return row?.count ?? 0;
}

/**
 * Create an audience for an app. A configuration write: run it inside
 * withConfigChange and pass its transaction.
 */
export async function createAudience(
  data: {
    appId: string;
    name: string;
    description?: string;
  },
  executor: Executor = db,
): Promise<SelectAudience> {
  const [audience] = await executor
    .insert(audiences)
    .values({
      appId: data.appId,
      name: data.name,
      description: data.description,
    })
    .returning();

  if (!audience) {
    throw new Error('Failed to create audience');
  }

  return audience;
}

/**
 * Get an audience by ID, scoped to appId.
 */
export async function getAudience(id: string, appId: string): Promise<SelectAudience | null> {
  const [audience] = await db
    .select()
    .from(audiences)
    .where(and(eq(audiences.id, id), eq(audiences.appId, appId)))
    .limit(1);

  return audience ?? null;
}

/**
 * List audiences for an app.
 */
export async function listAudiences(appId: string): Promise<SelectAudience[]> {
  return db.select().from(audiences).where(eq(audiences.appId, appId));
}

/**
 * Delete an audience, scoped to appId. Throws ConfigItemNotFoundError when
 * the app has no such audience. A configuration write: see createAudience.
 */
export async function deleteAudience(id: string, appId: string, executor: Executor = db): Promise<void> {
  const result = await executor
    .delete(audiences)
    .where(and(eq(audiences.id, id), eq(audiences.appId, appId)))
    .returning({ id: audiences.id });

  if (result.length === 0) {
    throw new ConfigItemNotFoundError('Audience');
  }
}

/**
 * Update an audience's mutable fields, scoped to appId. Null when the app has
 * no such audience. A configuration write: see createAudience.
 */
export async function updateAudience(
  id: string,
  appId: string,
  data: { name?: string; description?: string },
  executor: Executor = db,
): Promise<SelectAudience | null> {
  const [audience] = await executor
    .update(audiences)
    .set({ ...data })
    .where(and(eq(audiences.id, id), eq(audiences.appId, appId)))
    .returning();
  return audience ?? null;
}
