import { count, eq } from 'drizzle-orm';
import { apps, apiKeys, audiences, domains, emails } from '#drizzle/schema/index';
import type { InsertApp, SelectApp } from '#drizzle/schema/index';
import { db } from '#drizzle/db';
import { isUniqueViolationOf } from '#app/lib/pg-errors';
import { AppNameTakenError } from '#app/lib/app-name-taken';

export type { SelectApp as App };

/** The unique index on apps.name (drizzle/schema/apps.ts). */
const APP_NAME_UNIQUE_INDEX = 'apps_name_idx';

export { AppNameTakenError };

/**
 * Create a new app. App names are unique: the database refuses a second app
 * with the same name, also when two creates race, and this throws
 * AppNameTakenError for it.
 */
export async function createApp(data: { name: string }): Promise<SelectApp> {
  let app: SelectApp | undefined;
  try {
    [app] = await db.insert(apps).values({ name: data.name }).returning();
  } catch (err) {
    if (isUniqueViolationOf(err, APP_NAME_UNIQUE_INDEX)) throw new AppNameTakenError(data.name);
    throw err;
  }

  if (!app) {
    throw new Error('Failed to create app');
  }

  return app;
}

/**
 * Get an app by ID.
 */
export async function getAppById(id: string): Promise<SelectApp | null> {
  const [app] = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  return app ?? null;
}

/**
 * List all apps.
 */
export async function listApps(): Promise<SelectApp[]> {
  return db.select().from(apps);
}

/**
 * Typed error for deleteApp dependency checks and not-found cases.
 */
export class AppDeleteError extends Error {
  constructor(
    public readonly code: 'has_dependents' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AppDeleteError';
  }
}

/**
 * Delete an app by ID.
 *
 * Checks for dependent rows in api_keys, audiences, domains, and emails before
 * deleting. These tables have no ON DELETE CASCADE FK — safe deletion requires
 * all dependents to be removed first.
 *
 * Throws AppDeleteError with code 'has_dependents' if any dependent rows exist.
 * Throws AppDeleteError with code 'not_found' if the app does not exist.
 */
export async function deleteApp(id: string): Promise<void> {
  const [[apiKeyCount], [audienceCount], [domainCount], [emailCount]] = await Promise.all([
    db.select({ count: count() }).from(apiKeys).where(eq(apiKeys.appId, id)),
    db.select({ count: count() }).from(audiences).where(eq(audiences.appId, id)),
    db.select({ count: count() }).from(domains).where(eq(domains.appId, id)),
    db.select({ count: count() }).from(emails).where(eq(emails.appId, id)),
  ]);

  const dependentTables: string[] = [];
  if ((apiKeyCount?.count ?? 0) > 0) dependentTables.push('api_keys');
  if ((audienceCount?.count ?? 0) > 0) dependentTables.push('audiences');
  if ((domainCount?.count ?? 0) > 0) dependentTables.push('domains');
  if ((emailCount?.count ?? 0) > 0) dependentTables.push('emails');

  if (dependentTables.length > 0) {
    throw new AppDeleteError(
      'has_dependents',
      `Cannot delete app, dependent rows exist in: ${dependentTables.join(', ')}`,
    );
  }

  const result = await db.delete(apps).where(eq(apps.id, id)).returning({ id: apps.id });

  if (result.length === 0) {
    throw new AppDeleteError('not_found', `App ${id} not found`);
  }
}
