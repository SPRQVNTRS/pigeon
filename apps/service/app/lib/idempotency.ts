import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '#drizzle/db';
import { idempotentRequests } from '#drizzle/schema/index';

export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export type IdempotencyResult =
  | { type: 'fresh' }
  | { type: 'replay'; status: number; body: unknown }
  | { type: 'collision' };

export async function checkIdempotency(
  apiKeyId: string,
  key: string,
  requestBodyHash: string,
): Promise<IdempotencyResult> {
  const [row] = await db
    .select()
    .from(idempotentRequests)
    .where(and(eq(idempotentRequests.apiKeyId, apiKeyId), eq(idempotentRequests.key, key)))
    .limit(1);

  if (!row) return { type: 'fresh' };
  if (row.requestHash !== requestBodyHash) return { type: 'collision' };
  return { type: 'replay', status: row.responseStatus, body: row.responseBody };
}

export async function storeIdempotency(
  apiKeyId: string,
  key: string,
  requestBodyHash: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db
    .insert(idempotentRequests)
    .values({ apiKeyId, key, requestHash: requestBodyHash, responseStatus, responseBody })
    .onConflictDoNothing();
}
