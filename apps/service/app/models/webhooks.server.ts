import { randomBytes } from 'node:crypto';
import { eq, and, count } from 'drizzle-orm';
import { webhooks } from '#drizzle/schema/index';
import type { SelectWebhook } from '#drizzle/schema/index';
import { db } from '#drizzle/db';
import type { Executor } from '#app/lib/db-types';

export type { SelectWebhook as Webhook };

/**
 * Generate a webhook signing secret: 32 random bytes as 64 hex characters.
 */
export function generateSigningSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Get a webhook by id, scoped to appId.
 */
export async function getWebhookById(
  id: string,
  appId: string,
  executor: Executor = db,
): Promise<SelectWebhook | null> {
  const [webhook] = await executor
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.appId, appId)))
    .limit(1);
  return webhook ?? null;
}

/**
 * Get a webhook by its (normalised) URL, scoped to appId.
 */
export async function getWebhookByAppAndUrl(
  appId: string,
  url: string,
  executor: Executor = db,
): Promise<SelectWebhook | null> {
  const [webhook] = await executor
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.appId, appId), eq(webhooks.url, url)))
    .limit(1);
  return webhook ?? null;
}

/**
 * Count webhooks for an app.
 */
export async function countWebhooks(appId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(webhooks)
    .where(eq(webhooks.appId, appId));
  return row?.count ?? 0;
}

/**
 * Create a webhook for an app. A configuration write: run it inside
 * withConfigChange and pass its transaction.
 */
export async function createWebhook(
  data: {
    appId: string;
    url: string;
    signingSecret: string;
    eventTypes?: string[];
  },
  executor: Executor = db,
): Promise<SelectWebhook> {
  const [webhook] = await executor
    .insert(webhooks)
    .values({
      appId: data.appId,
      url: data.url,
      signingSecret: data.signingSecret,
      eventTypes: data.eventTypes ?? ['*'],
    })
    .returning();

  if (!webhook) {
    throw new Error('Failed to create webhook');
  }

  return webhook;
}

/**
 * List webhooks for an app.
 */
export async function listWebhooks(appId: string): Promise<SelectWebhook[]> {
  return db.select().from(webhooks).where(eq(webhooks.appId, appId));
}

/**
 * Update a webhook, scoped to appId. A configuration write: see createWebhook.
 */
export async function updateWebhook(
  id: string,
  appId: string,
  data: Partial<Pick<SelectWebhook, 'url' | 'signingSecret' | 'eventTypes' | 'enabled'>>,
  executor: Executor = db,
): Promise<SelectWebhook> {
  const [webhook] = await executor
    .update(webhooks)
    .set(data)
    .where(and(eq(webhooks.id, id), eq(webhooks.appId, appId)))
    .returning();

  if (!webhook) {
    throw new Error(`Webhook ${id} not found or not owned by app ${appId}`);
  }

  return webhook;
}

/**
 * Delete a webhook, scoped to appId. A configuration write: see createWebhook.
 * No route deletes a webhook today.
 */
export async function deleteWebhook(id: string, appId: string, executor: Executor = db): Promise<void> {
  const result = await executor
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.appId, appId)))
    .returning({ id: webhooks.id });

  if (result.length === 0) {
    throw new Error(`Webhook ${id} not found or not owned by app ${appId}`);
  }
}
