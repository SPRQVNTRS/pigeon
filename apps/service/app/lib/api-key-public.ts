import type { SelectApiKey } from '#drizzle/schema/index';

/**
 * The fields of an api_keys row that may leave the service. The key hash
 * (`hashedKey`) never does: with it an attacker can test guesses offline and
 * match the row to a leaked key. Build every response that holds a key row
 * from this function, never from the row itself.
 */
export interface PublicApiKey {
  id: string;
  appId: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rateLimitPerSecond: number | null;
}

export function toPublicApiKey(row: SelectApiKey): PublicApiKey {
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    rateLimitPerSecond: row.rateLimitPerSecond,
  };
}
