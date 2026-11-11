/**
 * No response that carries an api_keys row may carry the key hash.
 *
 * Every route and loader that returns key rows is called here with a row
 * whose hash is a unique marker. The raw body text must not contain the
 * marker, and every key object must have exactly the public field list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';

const HASH_MARKER = 'f00dfacecafe'.repeat(5) + 'beef';

const PUBLIC_FIELDS = ['appId', 'createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'rateLimitPerSecond', 'revokedAt'];

const KEY_ROW = {
  id: 'key_1',
  appId: 'app_1',
  name: 'Production',
  hashedKey: HASH_MARKER,
  prefix: 'ske_abcd',
  rateLimitPerSecond: 10,
  lastUsedAt: new Date('2026-11-01T10:00:00Z'),
  revokedAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-01T10:00:00Z'),
};

const mocks = vi.hoisted(() => ({
  listAllApiKeys: vi.fn(),
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  revokeApiKeyById: vi.fn(),
  getAppById: vi.fn(),
}));

vi.mock('#app/models/api-keys.server', () => ({
  listAllApiKeys: (...args: unknown[]) => mocks.listAllApiKeys(...args),
  listApiKeys: (...args: unknown[]) => mocks.listApiKeys(...args),
  createApiKey: (...args: unknown[]) => mocks.createApiKey(...args),
  getApiKeyById: (...args: unknown[]) => mocks.getApiKeyById(...args),
  revokeApiKeyById: (...args: unknown[]) => mocks.revokeApiKeyById(...args),
}));

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mocks.getAppById(...args),
}));

vi.mock('#app/services/session.server', () => ({
  sessionStorage: {
    getSession: async () => ({ get: () => undefined, set: () => undefined, unset: () => undefined }),
    commitSession: async () => 'session=value',
  },
}));

vi.mock('#app/lib/logger', () => ({
  createComponentLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const listRoute = await import('../app/routes/api.v1.admin.api-keys');
const idRoute = await import('../app/routes/api.v1.admin.api-keys.$id');
const uiKeysRoute = await import('../app/routes/admin.apps.$appId.keys');

function adminContext() {
  const store = new Map<object, unknown>([[userContext, { id: 1, role: 'admin', email: 'admin@example.com' }]]);
  return { get: (key: object) => store.get(key) };
}

async function expectNoHash(opts: { response: unknown; keyObjects: (body: any) => unknown[] }): Promise<void> {
  expect(opts.response).toBeInstanceOf(Response);
  const text = await (opts.response as Response).text();
  expect(text).not.toContain(HASH_MARKER);
  expect(text).not.toContain('hashedKey');
  const objects = opts.keyObjects(JSON.parse(text));
  expect(objects.length).toBeGreaterThan(0);
  for (const object of objects) expect(Object.keys(object as object).sort()).toEqual(PUBLIC_FIELDS);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAllApiKeys.mockResolvedValue([KEY_ROW]);
  mocks.listApiKeys.mockResolvedValue([KEY_ROW]);
  mocks.createApiKey.mockResolvedValue({ plaintext: 'ske_plaintext', record: KEY_ROW });
  mocks.getApiKeyById.mockResolvedValue(KEY_ROW);
  mocks.revokeApiKeyById.mockResolvedValue({ ...KEY_ROW, revokedAt: new Date() });
  mocks.getAppById.mockResolvedValue({ id: 'app_1', name: 'Test App', createdAt: new Date() });
});

describe('admin API key responses never hold the key hash', () => {
  it('GET /v1/admin/api-keys', async () => {
    const response = await listRoute.loader({
      request: new Request('http://localhost/v1/admin/api-keys?appId=app_1'),
    } as never);
    await expectNoHash({ response, keyObjects: (body) => body.apiKeys });
  });

  it('POST /v1/admin/api-keys', async () => {
    const response = await listRoute.action({
      request: new Request('http://localhost/v1/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'app_1', name: 'Production' }),
      }),
    } as never);
    expect((response as Response).status).toBe(201);
    await expectNoHash({ response, keyObjects: (body) => [body.apiKey] });
  });

  it('GET /v1/admin/api-keys/:id', async () => {
    const response = await idRoute.loader({ params: { id: 'key_1' } } as never);
    await expectNoHash({ response, keyObjects: (body) => [body.apiKey] });
  });

  it('DELETE /v1/admin/api-keys/:id', async () => {
    const response = await idRoute.action({
      request: new Request('http://localhost/v1/admin/api-keys/key_1', { method: 'DELETE' }),
      params: { id: 'key_1' },
    } as never);
    await expectNoHash({ response, keyObjects: (body) => [body.apiKey] });
  });

  it('the admin UI keys loader', async () => {
    const response = await uiKeysRoute.loader({
      request: new Request('http://localhost/admin/apps/app_1/keys'),
      params: { appId: 'app_1' },
      context: adminContext(),
    } as never);
    await expectNoHash({ response, keyObjects: (body) => body.keys });
  });
});
