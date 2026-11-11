/**
 * Unit tests: Admin UI — Webhooks CRUD
 *
 * Tests:
 * - list loader: returns webhooks for appId
 * - list loader: reads and consumes newWebhookSecret flash
 * - create action: valid HTTPS URL → redirect to webhook detail
 * - create action: stores signing secret in flash
 * - create action: non-HTTPS URL → validation error
 * - detail loader: returns webhook by ID
 * - detail loader: throws 404 for unknown ID
 * - detail action/edit: updates URL and eventTypes
 * - detail action/disable: marks webhook disabled
 * - detail action/enable: marks webhook enabled
 * - detail action/rotate-secret: generates new secret, stores in flash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import type { Route as WebhooksRoute } from '../app/routes/+types/admin.apps.$appId.webhooks';
import type { Route as WebhookDetailRoute } from '../app/routes/+types/admin.apps.$appId.webhooks.$webhookId';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockListWebhooks = vi.fn();
const mockCreateWebhook = vi.fn();
const mockUpdateWebhook = vi.fn();
const mockGetAppById = vi.fn().mockResolvedValue({ id: 'app_1', name: 'Test App', createdAt: new Date() });

const mockLookup = vi.hoisted(() => vi.fn());
// The registration check under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny resolves the host. Never for real here.
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

vi.mock('#app/models/config-change.server', () => import('./support/config-change-passthrough'));
vi.mock('#app/models/webhooks.server', () => ({
  listWebhooks: mockListWebhooks,
  createWebhook: mockCreateWebhook,
  updateWebhook: mockUpdateWebhook,
  generateSigningSecret: () => 'a'.repeat(64),
}));

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mockGetAppById(...args),
}));

// DB mock for getWebhookById
const mockDbSelect = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};
vi.mock('#drizzle/db', () => ({ db: mockDbSelect }));
vi.mock('#drizzle/schema/index', () => ({
  webhooks: { id: 'id', appId: 'app_id' },
  apps: { id: 'id' },
}));
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(), and: vi.fn() };
});

// Session mock
const mockSessionData: Record<string, unknown> = {};
const mockSession = {
  get: (key: string) => mockSessionData[key],
  set: (key: string, value: unknown) => { mockSessionData[key] = value; },
  unset: (key: string) => { delete mockSessionData[key]; },
};
const mockCommitSession = vi.fn().mockResolvedValue('session=value');
const mockGetSession = vi.fn().mockResolvedValue(mockSession);

vi.mock('#app/services/session.server', () => ({
  sessionStorage: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    commitSession: (...args: unknown[]) => mockCommitSession(...args),
  },
}));

// ─── Admin context ─────────────────────────────────────────────────────────

const ADMIN_USER = {
  id: 1, email: 'admin@example.com', name: 'Admin', role: 'admin' as const,
  password: 'h', deactivated: false, createdAt: new Date(), updatedAt: new Date(),
};

function makeAdminContext() {
  const store = new Map<object, unknown>();
  store.set(userContext, ADMIN_USER);
  return { get: (key: object) => store.get(key) };
}

// ─── Route imports ──────────────────────────────────────────────────────────

const { loader: webhooksLoader, action: webhooksAction } = await import(
  '../app/routes/admin.apps.$appId.webhooks'
);
const { loader: detailLoader, action: detailAction } = await import(
  '../app/routes/admin.apps.$appId.webhooks.$webhookId'
);

// ─── Test data ───────────────────────────────────────────────────────────────

const MOCK_WEBHOOK = {
  id: 'wh_1',
  appId: 'app_1',
  url: 'https://example.com/webhook',
  signingSecret: 'secret_hash_stored',
  eventTypes: ['email.sent', 'email.bounced'],
  enabled: true,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // The default is deny, which resolves the host. Most tests here cover the
  // create and edit flow with made-up hosts, so they allow private targets
  // explicitly. The target rule blocks below set their own value.
  vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
  Object.keys(mockSessionData).forEach((k) => delete mockSessionData[k]);
  mockGetSession.mockResolvedValue(mockSession);
  mockCommitSession.mockResolvedValue('session=value');
  mockDbSelect.limit.mockResolvedValue([MOCK_WEBHOOK]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Webhooks list loader ─────────────────────────────────────────────────────

describe('GET /admin/apps/:appId/webhooks (list loader)', () => {
  it('returns webhooks for appId', async () => {
    mockListWebhooks.mockResolvedValue([MOCK_WEBHOOK]);
    const req = new Request('http://localhost/admin/apps/app_1/webhooks');
    const response = await webhooksLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.LoaderArgs);

    const data = await (response as Response).json() as { webhooks: typeof MOCK_WEBHOOK[] };
    expect(data.webhooks).toHaveLength(1);
    expect(data.webhooks[0].url).toBe('https://example.com/webhook');
  });

  it('reads and consumes newWebhookSecret flash', async () => {
    mockListWebhooks.mockResolvedValue([]);
    mockSessionData['newWebhookSecret'] = 'some_secret_value';

    const req = new Request('http://localhost/admin/apps/app_1/webhooks');
    const response = await webhooksLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.LoaderArgs);

    const data = await (response as Response).json() as { newWebhookSecret: string | null };
    expect(data.newWebhookSecret).toBe('some_secret_value');
    expect(mockSessionData['newWebhookSecret']).toBeUndefined();
    expect(mockCommitSession).toHaveBeenCalled();
  });
});

// ─── Create action ────────────────────────────────────────────────────────────

describe('POST /admin/apps/:appId/webhooks (create action)', () => {
  it('creates webhook and redirects to detail page', async () => {
    mockCreateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK, id: 'wh_new' });

    const body = new URLSearchParams({ url: 'https://example.com/wh', subscribeAll: 'on' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await webhooksAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('Location')).toBe('/admin/apps/app_1/webhooks/wh_new');
  });

  it('stores signing secret in session flash', async () => {
    mockCreateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK, id: 'wh_new' });

    const body = new URLSearchParams({ url: 'https://example.com/wh', subscribeAll: 'on' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await webhooksAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.ActionArgs);

    expect(typeof mockSessionData['newWebhookSecret']).toBe('string');
    expect((mockSessionData['newWebhookSecret'] as string).length).toBeGreaterThan(0);
    expect(mockCommitSession).toHaveBeenCalled();
  });

  it('returns validation error for non-HTTPS URL', async () => {
    const body = new URLSearchParams({ url: 'http://example.com/wh', subscribeAll: 'on' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await webhooksAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });
});

// ─── Detail loader ────────────────────────────────────────────────────────────

describe('GET /admin/apps/:appId/webhooks/:webhookId (detail loader)', () => {
  it('returns webhook by ID', async () => {
    mockDbSelect.limit.mockResolvedValue([MOCK_WEBHOOK]);
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/wh_1');
    const response = await detailLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.LoaderArgs);

    const data = await (response as Response).json() as { webhook: typeof MOCK_WEBHOOK };
    expect(data.webhook.id).toBe('wh_1');
  });

  it('throws 404 for unknown webhook', async () => {
    mockDbSelect.limit.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/unknown');
    await expect(
      detailLoader({
        request: req,
        context: makeAdminContext(),
        params: { appId: 'app_1', webhookId: 'unknown' },
      } as unknown as WebhookDetailRoute.LoaderArgs),
    ).rejects.toSatisfy((e: unknown) => e instanceof Response && e.status === 404);
  });
});

// ─── Detail actions ───────────────────────────────────────────────────────────

describe('POST /admin/apps/:appId/webhooks/:webhookId (detail actions)', () => {
  it('edit intent: updates URL and eventTypes', async () => {
    mockUpdateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK });
    const body = new URLSearchParams({
      intent: 'edit',
      url: 'https://new.example.com/wh',
      'eventTypes': 'email.sent',
    });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/wh_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await detailAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect(mockUpdateWebhook).toHaveBeenCalledWith(
      'wh_1',
      'app_1',
      expect.objectContaining({ url: 'https://new.example.com/wh' }),
      expect.anything(),
    );
  });

  it('disable intent: marks webhook disabled', async () => {
    mockUpdateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK, enabled: false });
    const body = new URLSearchParams({ intent: 'disable' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/wh_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await detailAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.ActionArgs);

    expect(mockUpdateWebhook).toHaveBeenCalledWith('wh_1', 'app_1', { enabled: false }, expect.anything());
  });

  it('enable intent: marks webhook enabled', async () => {
    mockUpdateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK, enabled: true });
    const body = new URLSearchParams({ intent: 'enable' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/wh_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await detailAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.ActionArgs);

    expect(mockUpdateWebhook).toHaveBeenCalledWith('wh_1', 'app_1', { enabled: true }, expect.anything());
  });

  it('rotate-secret intent: generates new secret and stores in flash', async () => {
    mockUpdateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK });
    const body = new URLSearchParams({ intent: 'rotate-secret' });
    const req = new Request('http://localhost/admin/apps/app_1/webhooks/wh_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await detailAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect(typeof mockSessionData['newWebhookSecret']).toBe('string');
    expect((mockSessionData['newWebhookSecret'] as string).length).toBeGreaterThan(0);
    expect(mockUpdateWebhook).toHaveBeenCalledWith('wh_1', 'app_1', { signingSecret: expect.any(String) }, expect.anything());
    expect(mockCommitSession).toHaveBeenCalled();
  });
});

// ─── Target rules (PIGEON_WEBHOOK_PRIVATE_TARGETS) ───────────────────────────

describe('admin UI webhook forms under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny', () => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'deny');
    mockLookup.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function formRequest(fields: Record<string, string>, path: string): Request {
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it('create: shows a field error for a host that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '100.64.0.7', family: 4 }]);
    const result = await webhooksAction({
      request: formRequest({ url: 'https://hooks.example.com/x', subscribeAll: 'on' }, '/admin/apps/app_1/webhooks'),
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { error?: Record<string, string[]> }).error?.url).toEqual([
      'URL must not point to a private or local address (100.64.0.7)',
    ]);
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it('edit: shows a field error for a host that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const result = await detailAction({
      request: formRequest({ intent: 'edit', url: 'https://hooks.example.com/x', subscribeAll: 'on' }, '/admin/apps/app_1/webhooks/wh_1'),
      context: makeAdminContext(),
      params: { appId: 'app_1', webhookId: 'wh_1' },
    } as unknown as WebhookDetailRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { error?: Record<string, string[]> }).error?.url).toEqual([
      'URL must not point to a private or local address (169.254.169.254)',
    ]);
    expect(mockUpdateWebhook).not.toHaveBeenCalled();
  });

  it('create: goes through when every address is public', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    mockCreateWebhook.mockResolvedValue({ ...MOCK_WEBHOOK, id: 'wh_new' });
    const result = await webhooksAction({
      request: formRequest({ url: 'https://hooks.example.com/x', subscribeAll: 'on' }, '/admin/apps/app_1/webhooks'),
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as WebhooksRoute.ActionArgs);

    expect((result as Response).status).toBe(302);
  });
});
