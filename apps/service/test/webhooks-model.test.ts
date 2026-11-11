/**
 * Unit tests: webhooks model helpers that need no database
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('#drizzle/db', () => ({ db: {} }));

const { generateSigningSecret } = await import('#app/models/webhooks.server');

describe('generateSigningSecret', () => {
  it('returns 64 lowercase hex characters (32 random bytes)', () => {
    expect(generateSigningSecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different value on every call', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateSigningSecret()));
    expect(secrets.size).toBe(20);
  });
});
