/**
 * Per-key rate limit in the API key auth path.
 *
 * verifyApiKey is mocked; the limiter is the real token bucket on fake timers.
 * The last block sends requests through the real React Router request handler,
 * so the 429 and its Retry-After header are what a client really receives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SelectApiKey } from '#drizzle/schema/index';
import { createTokenBucketLimiter } from '#app/lib/rate-limit';
import { apiKeyContext } from '../api-key-context';

const mockVerifyApiKey = vi.hoisted(() => vi.fn());

vi.mock('../../models/api-keys.server', () => ({
  verifyApiKey: mockVerifyApiKey,
  touchLastUsed: vi.fn(async () => undefined),
}));

const { createApiKeyAuthMiddleware, apiKeyAuthMiddleware } = await import('../api-key-auth');

type Middleware = ReturnType<typeof createApiKeyAuthMiddleware>;

function keyRow(opts: { id?: string; rateLimitPerSecond: number | null }): SelectApiKey {
  return {
    id: opts.id ?? 'key_1',
    appId: 'app_1',
    name: 'test',
    hashedKey: 'a'.repeat(64),
    prefix: 'ske_abcd',
    rateLimitPerSecond: opts.rateLimitPerSecond,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function contextStub(): { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  return { set: vi.fn(), get: vi.fn() };
}

async function call(middleware: Middleware): Promise<Response> {
  const request = new Request('http://localhost/v1/emails/e1', { headers: { authorization: 'Bearer ske_test' } });
  const args = { request, context: contextStub(), params: {} } as unknown as Parameters<Middleware>[0];
  const result = await middleware(args, async () => Response.json({ ok: true }));
  if (!(result instanceof Response)) throw new Error('middleware returned no Response');
  return result;
}

async function statuses(opts: { middleware: Middleware; count: number }): Promise<number[]> {
  const results: number[] = [];
  for (let i = 0; i < opts.count; i += 1) results.push((await call(opts.middleware)).status);
  return results;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  mockVerifyApiKey.mockReset();
});

describe('createApiKeyAuthMiddleware with PIGEON_RATE_LIMIT=enforce', () => {
  function enforcing(): Middleware {
    return createApiKeyAuthMiddleware({ limiter: createTokenBucketLimiter(), resolveMode: () => 'enforce' });
  }

  it('passes requests under the limit', async () => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: 3 }));
    expect(await statuses({ middleware: enforcing(), count: 3 })).toEqual([200, 200, 200]);
  });

  it('answers a burst over the limit with 429, rate_limited and Retry-After', async () => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: 2 }));
    const middleware = enforcing();
    expect(await statuses({ middleware, count: 2 })).toEqual([200, 200]);
    const refused = await call(middleware);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
  });

  it.each([0, -3])('blocks a key whose rate_limit_per_second is %i with 429 and Retry-After 1', async (rate) => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: rate }));
    const middleware = enforcing();
    const refused = await call(middleware);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    vi.advanceTimersByTime(60_000);
    expect((await call(middleware)).status).toBe(429);
  });

  it('lets requests through again once the bucket refills', async () => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: 2 }));
    const middleware = enforcing();
    expect(await statuses({ middleware, count: 3 })).toEqual([200, 200, 429]);
    vi.advanceTimersByTime(1_000);
    expect(await statuses({ middleware, count: 3 })).toEqual([200, 200, 429]);
  });

  it('never limits a key whose column is NULL', async () => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: null }));
    const results = await statuses({ middleware: enforcing(), count: 200 });
    expect(results.every((status) => status === 200)).toBe(true);
  });

  it('limits each key on its own budget', async () => {
    const middleware = enforcing();
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_a', rateLimitPerSecond: 1 }));
    expect(await statuses({ middleware, count: 2 })).toEqual([200, 429]);
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_b', rateLimitPerSecond: 1 }));
    expect(await statuses({ middleware, count: 1 })).toEqual([200]);
  });

  it('still answers 401 for a bad key, before any limit', async () => {
    mockVerifyApiKey.mockResolvedValue(null);
    expect((await call(enforcing())).status).toBe(401);
  });

  it('puts the column value in the context, null when unlimited', async () => {
    mockVerifyApiKey.mockResolvedValue(keyRow({ rateLimitPerSecond: null }));
    const context = contextStub();
    const request = new Request('http://localhost/v1/emails/e1', { headers: { authorization: 'Bearer ske_test' } });
    const args = { request, context, params: {} } as unknown as Parameters<Middleware>[0];
    await enforcing()(args, async () => Response.json({ ok: true }));
    expect(context.set).toHaveBeenCalledWith(apiKeyContext, { apiKeyId: 'key_1', appId: 'app_1', rateLimitPerSecond: null });
  });
});

describe('the exported apiKeyAuthMiddleware reads PIGEON_RATE_LIMIT', () => {
  it('limits while PIGEON_RATE_LIMIT is unset (the default is enforce)', async () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', '');
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_unset', rateLimitPerSecond: 1 }));
    expect(await statuses({ middleware: apiKeyAuthMiddleware, count: 2 })).toEqual([200, 429]);
  });

  it('never limits with PIGEON_RATE_LIMIT=off', async () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', 'off');
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_off', rateLimitPerSecond: 1 }));
    const results = await statuses({ middleware: apiKeyAuthMiddleware, count: 50 });
    expect(results.every((status) => status === 200)).toBe(true);
  });

  it('limits with PIGEON_RATE_LIMIT=enforce', async () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', 'enforce');
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_enforce', rateLimitPerSecond: 1 }));
    expect(await statuses({ middleware: apiKeyAuthMiddleware, count: 2 })).toEqual([200, 429]);
  });

  it('throws on any other value instead of guessing', async () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', 'yes');
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_bad', rateLimitPerSecond: 1 }));
    await expect(call(apiKeyAuthMiddleware)).rejects.toThrow(/PIGEON_RATE_LIMIT must be one of enforce, off/);
  });
});

describe('through the real request handler', () => {
  it('sends 429 with Retry-After and never runs the route loader', async () => {
    vi.useRealTimers();
    vi.stubEnv('PIGEON_RATE_LIMIT', 'enforce');
    mockVerifyApiKey.mockResolvedValue(keyRow({ id: 'key_handler', rateLimitPerSecond: 1 }));
    const { createApiHandler } = await import('../../../test/support/api-server');
    const apiLayout = await import('../../routes/_api');
    const loader = vi.fn(async () => Response.json({ ok: true }));
    const handle = createApiHandler({
      modules: { 'routes/_api.tsx': apiLayout, 'routes/api.v1.emails.$id.tsx': { loader } },
    });
    const request = (): Request =>
      new Request('http://localhost/v1/emails/e1', { headers: { authorization: 'Bearer ske_test' } });

    expect((await handle(request())).status).toBe(200);
    const refused = await handle(request());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect(await refused.json()).toEqual({ error: 'rate_limited' });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
