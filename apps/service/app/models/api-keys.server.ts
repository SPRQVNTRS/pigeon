import { randomBytes, createHash } from 'node:crypto';
import { eq, and, desc, count } from 'drizzle-orm';
import { apiKeys } from '#drizzle/schema/index';
import type { SelectApiKey } from '#drizzle/schema/index';
import { db } from '#drizzle/db';

export type { SelectApiKey };

/**
 * Key prefix for email service API keys.
 */
const KEY_PREFIX = 'ske_';

/**
 * Create a new API key for the given app.
 * Returns the plaintext key (only time it's visible) and the DB record.
 *
 * Key format: "ske_" + 64 hex chars (32 random bytes)
 */
export async function createApiKey(data: {
  appId: string;
  name: string;
}): Promise<{ plaintext: string; record: SelectApiKey }> {
  const raw = randomBytes(32).toString('hex');
  const plaintext = `${KEY_PREFIX}${raw}`;
  const prefix = plaintext.slice(0, 8);
  const hashedKey = createHash('sha256').update(plaintext).digest('hex');

  const [record] = await db
    .insert(apiKeys)
    .values({
      appId: data.appId,
      name: data.name,
      hashedKey,
      prefix,
    })
    .returning();

  if (!record) {
    throw new Error('Failed to create API key');
  }

  return { plaintext, record };
}

/**
 * Verify a raw API key. Returns the record if valid and not revoked, null otherwise.
 */
export async function verifyApiKey(raw: string): Promise<SelectApiKey | null> {
  const prefix = raw.slice(0, 8);
  const hashedKey = createHash('sha256').update(raw).digest('hex');

  const [record] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.hashedKey, hashedKey)))
    .limit(1);

  if (!record) return null;

  // Reject revoked keys
  if (record.revokedAt !== null) return null;

  return record;
}

/**
 * Revoke an API key — filtered by appId to prevent cross-tenant revocation.
 */
export async function revokeApiKey(id: string, appId: string): Promise<SelectApiKey> {
  const [record] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.appId, appId)))
    .returning();

  if (!record) {
    throw new Error(`API key ${id} not found or not owned by app ${appId}`);
  }

  return record;
}

/**
 * List API keys for an app.
 */
export async function listApiKeys(appId: string): Promise<SelectApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.appId, appId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Touch lastUsedAt — called after successful auth.
 */
export async function touchLastUsed(id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

/**
 * List all API keys, optionally filtered by appId.
 * Admin-only — no appId scope requirement.
 */
export async function listAllApiKeys(appId?: string): Promise<SelectApiKey[]> {
  if (appId) {
    return db.select().from(apiKeys).where(eq(apiKeys.appId, appId)).orderBy(desc(apiKeys.createdAt));
  }
  return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
}

/**
 * Count API keys for an app.
 */
export async function countApiKeys(appId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(apiKeys)
    .where(eq(apiKeys.appId, appId));
  return row?.count ?? 0;
}

/**
 * Get an API key by ID.
 * Admin-only — no appId scope check.
 */
export async function getApiKeyById(id: string): Promise<SelectApiKey | null> {
  const [record] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return record ?? null;
}

/**
 * Revoke an API key by ID only — no appId scope check.
 * Admin-only operation. The existing revokeApiKey(id, appId) is kept for tenant-scoped revocation.
 */
export async function revokeApiKeyById(id: string): Promise<SelectApiKey> {
  const [record] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(apiKeys.id, id))
    .returning();

  if (!record) {
    throw new Error(`API key ${id} not found`);
  }

  return record;
}
