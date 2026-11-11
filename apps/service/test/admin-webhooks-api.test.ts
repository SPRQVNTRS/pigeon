/**
 * Unit tests: Bearer admin API for webhooks
 *
 * GET  /v1/admin/apps/:id/webhooks
 * POST /v1/admin/apps/:id/webhooks
 * POST /v1/admin/apps/:id/webhooks/:webhookId/rotate
 *
 * Models are mocked; no database needed. The admin layout guard is covered at
 * the bottom of this file.
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Route as WebhooksRoute } from '../app/routes/+types/api.v1.admin.apps.$id.webhooks';
import type { Route as RotateRoute } from '../app/routes/+types/api.v1.admin.apps.$id.webhooks.$webhookId.rotate';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getAppById: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  getWebhookById: vi.fn(),
  getWebhookByAppAndUrl: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const mockLookup = vi.hoisted(() => vi.fn());
// The registration check under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny resolves the host. Never for real here.
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

vi.mock('#app/models/config-change.server', () => import('./support/config-change-passthrough'));
vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mocks.getAppById(...args),
}));

vi.mock('#app/models/webhooks.server', () => ({
  listWebhooks: (...args: unknown[]) => mocks.listWebhooks(...args),
  createWebhook: (...args: unknown[]) => mocks.createWebhook(...args),
  updateWebhook: (...args: unknown[]) => mocks.updateWebhook(...args),
  getWebhookById: (...args: unknown[]) => mocks.getWebhookById(...args),
  getWebhookByAppAndUrl: (...args: unknown[]) => mocks.getWebhookByAppAndUrl(...args),
  // Same recipe as the real function; the real one is tested in webhooks-model.test.ts.
  generateSigningSecret: () => randomBytes(32).toString('hex'),
}));

vi.mock('#app/lib/logger', () => ({
  createComponentLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
  }),
}));

// ─── Route imports ──────────────────────────────────────────────────────────

const { loader: listLoader, action: createAction } = await import(
  '../app/routes/api.v1.admin.apps.$id.webhooks'
);
const { loader: rotateLoader, action: rotateAction } = await import(
  '../app/routes/api.v1.admin.apps.$id.webhooks.$webhookId.rotate'
);

// ─── Test data ───────────────────────────────────────────────────────────────

const STORED_SECRET = 'stored-secret-must-never-leak-0123456789abcdef0123456789abcdef';

const WEBHOOK_ROW = {
  id: 'wh_1',
  appId: 'app_1',
  url: 'https://example.com/hook',
  signingSecret: STORED_SECRET,
  eventTypes: ['email.sent'],
  enabled: true,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: new Date('2026-11-01T10:00:00Z'),
  updatedAt: new Date('2026-11-01T10:00:00Z'),
};

const HEX_64 = /^[0-9a-f]{64}$/;

function listArgs(appId = 'app_1') {
  return {
    request: new Request(`http://localhost/v1/admin/apps/${appId}/webhooks`),
    params: { id: appId },
  } as unknown as WebhooksRoute.LoaderArgs;
}

function createArgs(body: unknown, options: { appId?: string; method?: string; raw?: string } = {}) {
  const { appId = 'app_1', method = 'POST', raw } = options;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return {
    request: new Request(`http://localhost/v1/admin/apps/${appId}/webhooks`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: hasBody ? (raw ?? JSON.stringify(body)) : undefined,
    }),
    params: { id: appId },
  } as unknown as WebhooksRoute.ActionArgs;
}

function rotateArgs(options: { appId?: string; webhookId?: string; method?: string } = {}) {
  const { appId = 'app_1', webhookId = 'wh_1', method = 'POST' } = options;
  return {
    request: new Request(`http://localhost/v1/admin/apps/${appId}/webhooks/${webhookId}/rotate`, { method }),
    params: { id: appId, webhookId },
  } as unknown as RotateRoute.ActionArgs;
}

async function readJson(response: unknown): Promise<any> {
  expect(response).toBeInstanceOf(Response);
  return (response as Response).json();
}

function expectNoStore(response: unknown): void {
  expect((response as Response).headers.get('Cache-Control')).toBe('no-store');
}

beforeEach(() => {
  vi.resetAllMocks();
  // The default is deny, which resolves the host. Most tests here cover the
  // create and edit flow with made-up hosts, so they allow private targets
  // explicitly. The target rule blocks below set their own value.
  vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
  mocks.getAppById.mockResolvedValue({ id: 'app_1', name: 'Test App' });
  mocks.getWebhookByAppAndUrl.mockResolvedValue(null);
  mocks.createWebhook.mockImplementation(async (data: { appId: string; url: string; signingSecret: string; eventTypes: string[] }) => ({
    ...WEBHOOK_ROW,
    id: 'wh_new',
    appId: data.appId,
    url: data.url,
    signingSecret: data.signingSecret,
    eventTypes: data.eventTypes,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe('GET /v1/admin/apps/:id/webhooks', () => {
  it('lists webhooks and never exposes signingSecret', async () => {
    mocks.listWebhooks.mockResolvedValue([WEBHOOK_ROW]);

    const response = await listLoader(listArgs());
    const raw = JSON.stringify(await readJson(response.clone()));
    const data = await readJson(response);

    expect((response as Response).status).toBe(200);
    expect(data.webhooks).toHaveLength(1);
    expect(Object.keys(data.webhooks[0]).sort()).toEqual(
      ['appId', 'createdAt', 'enabled', 'eventTypes', 'id', 'lastFailureAt', 'lastSuccessAt', 'updatedAt', 'url'].sort(),
    );
    expect(data.webhooks[0]).toMatchObject({
      id: 'wh_1',
      appId: 'app_1',
      url: 'https://example.com/hook',
      eventTypes: ['email.sent'],
      enabled: true,
    });
    expect(raw).not.toContain('signingSecret');
    expect(raw).not.toContain(STORED_SECRET);
    expectNoStore(response);
    expect(mocks.listWebhooks).toHaveBeenCalledWith('app_1');
  });

  it('returns an empty list for an app without webhooks', async () => {
    mocks.listWebhooks.mockResolvedValue([]);
    const data = await readJson(await listLoader(listArgs()));
    expect(data).toEqual({ webhooks: [] });
  });

  it('answers 404 app_not_found for an unknown app', async () => {
    mocks.getAppById.mockResolvedValue(null);

    const response = await listLoader(listArgs('nope'));
    const data = await readJson(response);

    expect((response as Response).status).toBe(404);
    expect(data.error.code).toBe('app_not_found');
    expectNoStore(response);
    expect(mocks.listWebhooks).not.toHaveBeenCalled();
  });
});

// ─── POST create ──────────────────────────────────────────────────────────────

describe('POST /v1/admin/apps/:id/webhooks', () => {
  it('creates a webhook, stores the normalised URL and returns a 64-hex secret once', async () => {
    const response = await createAction(
      createArgs({ url: 'https://EXAMPLE.com:443/hook#frag', eventTypes: ['email.sent', 'email.sent', 'email.bounced'] }),
    );
    const data = await readJson(response);

    expect((response as Response).status).toBe(201);
    expect(data.signingSecret).toMatch(HEX_64);

    expect(mocks.createWebhook).toHaveBeenCalledTimes(1);
    const stored = mocks.createWebhook.mock.calls[0]![0];
    expect(stored).toMatchObject({
      appId: 'app_1',
      url: 'https://example.com/hook',
      eventTypes: ['email.sent', 'email.bounced'],
    });
    expect(stored.signingSecret).toBe(data.signingSecret);
    expect(mocks.getWebhookByAppAndUrl).toHaveBeenCalledWith('app_1', 'https://example.com/hook', expect.anything());

    expect(data.webhook).toMatchObject({
      id: 'wh_new',
      url: 'https://example.com/hook',
      eventTypes: ['email.sent', 'email.bounced'],
    });
    expect(data.webhook).not.toHaveProperty('signingSecret');
    expectNoStore(response);
  });

  it('accepts the wildcard event type', async () => {
    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }));
    expect((response as Response).status).toBe(201);
    expect(mocks.createWebhook.mock.calls[0]![0].eventTypes).toEqual(['*']);
  });

  it('logs create with appId, webhookId and url but never the secret', async () => {
    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }));
    const { signingSecret } = await readJson(response);

    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [, context] = mocks.logInfo.mock.calls[0]!;
    expect(context).toEqual({ appId: 'app_1', webhookId: 'wh_new', url: 'https://example.com/hook' });
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(signingSecret);
  });

  it('answers 409 webhook_exists when the normalised URL already exists, without a secret', async () => {
    mocks.getWebhookByAppAndUrl.mockResolvedValue(WEBHOOK_ROW);

    const response = await createAction(createArgs({ url: 'https://EXAMPLE.com/hook', eventTypes: ['*'] }));
    const raw = await (response as Response).clone().text();
    const data = await readJson(response);

    expect((response as Response).status).toBe(409);
    expect(data.error).toMatchObject({ code: 'webhook_exists', webhookId: 'wh_1' });
    expect(raw).not.toContain('signingSecret');
    expect(raw).not.toContain(STORED_SECRET);
    expectNoStore(response);
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it('answers 409 when the insert loses a race (Postgres 23505)', async () => {
    mocks.getWebhookByAppAndUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(WEBHOOK_ROW);
    mocks.createWebhook.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(409);
    expect(data.error).toMatchObject({ code: 'webhook_exists', webhookId: 'wh_1' });
    expect(JSON.stringify(data)).not.toContain('signingSecret');
    expectNoStore(response);
  });

  it('recognises a 23505 wrapped in a Drizzle error cause', async () => {
    mocks.getWebhookByAppAndUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(WEBHOOK_ROW);
    const driverError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mocks.createWebhook.mockRejectedValue(new Error('Failed query', { cause: driverError }));

    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }));
    expect((response as Response).status).toBe(409);
  });

  it('answers 500 for other insert failures', async () => {
    mocks.createWebhook.mockRejectedValue(new Error('connection reset'));

    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(500);
    expect(data.error.code).toBe('internal_error');
    expect(JSON.stringify(data)).not.toContain('connection reset');
    expectNoStore(response);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it.each([
    ['http URL', { url: 'http://example.com/hook', eventTypes: ['*'] }],
    ['userinfo', { url: 'https://user:pw@example.com/hook', eventTypes: ['*'] }],
    ['IPv4 literal', { url: 'https://203.0.113.7/hook', eventTypes: ['*'] }],
    ['IPv6 literal', { url: 'https://[2001:db8::1]/hook', eventTypes: ['*'] }],
    ['localhost', { url: 'https://localhost/hook', eventTypes: ['*'] }],
    ['*.localhost', { url: 'https://svc.localhost/hook', eventTypes: ['*'] }],
    ['not a URL', { url: 'nope', eventTypes: ['*'] }],
    ['missing url', { eventTypes: ['*'] }],
    ['unknown event', { url: 'https://example.com/hook', eventTypes: ['email.exploded'] }],
    ['wildcard mixed with others', { url: 'https://example.com/hook', eventTypes: ['*', 'email.sent'] }],
    ['empty events', { url: 'https://example.com/hook', eventTypes: [] }],
    ['missing events', { url: 'https://example.com/hook' }],
    ['events not an array', { url: 'https://example.com/hook', eventTypes: 'email.sent' }],
  ])('answers 422 validation_error for %s', async (_label, body) => {
    const response = await createAction(createArgs(body));
    const data = await readJson(response);

    expect((response as Response).status).toBe(422);
    expect(data.error.code).toBe('validation_error');
    expect(Array.isArray(data.error.issues)).toBe(true);
    expect(data.error.issues.length).toBeGreaterThan(0);
    expectNoStore(response);
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it('answers 422 for a JSON body that is not an object', async () => {
    const response = await createAction(createArgs(null));
    expect((response as Response).status).toBe(422);
  });

  it('answers 400 invalid_json for a malformed body', async () => {
    const response = await createAction(createArgs(undefined, { raw: '{not json' }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(400);
    expect(data.error.code).toBe('invalid_json');
    expectNoStore(response);
  });

  it('answers 404 app_not_found for an unknown app', async () => {
    mocks.getAppById.mockResolvedValue(null);

    const response = await createAction(createArgs({ url: 'https://example.com/hook', eventTypes: ['*'] }, { appId: 'nope' }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(404);
    expect(data.error.code).toBe('app_not_found');
    expectNoStore(response);
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('answers 405 for %s', async (method) => {
    const response = await createAction(createArgs({}, { method }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(405);
    expect(data.error.code).toBe('method_not_allowed');
    expect((response as Response).headers.get('Allow')).toBe('GET, POST');
    expectNoStore(response);
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });
});

// ─── POST rotate ──────────────────────────────────────────────────────────────

describe('POST /v1/admin/apps/:id/webhooks/:webhookId/rotate', () => {
  beforeEach(() => {
    mocks.getWebhookById.mockResolvedValue(WEBHOOK_ROW);
    mocks.updateWebhook.mockImplementation(async (_id: string, _appId: string, data: { signingSecret: string }) => ({
      ...WEBHOOK_ROW,
      signingSecret: data.signingSecret,
    }));
  });

  it('stores a fresh secret and returns it once', async () => {
    const response = await rotateAction(rotateArgs());
    const data = await readJson(response);

    expect((response as Response).status).toBe(200);
    expect(data.signingSecret).toMatch(HEX_64);
    expect(data.signingSecret).not.toBe(STORED_SECRET);

    expect(mocks.getWebhookById).toHaveBeenCalledWith('wh_1', 'app_1', expect.anything());
    expect(mocks.updateWebhook).toHaveBeenCalledWith('wh_1', 'app_1', { signingSecret: data.signingSecret }, expect.anything());

    expect(data.webhook).toMatchObject({ id: 'wh_1', appId: 'app_1', url: 'https://example.com/hook' });
    expect(data.webhook).not.toHaveProperty('signingSecret');
    expectNoStore(response);
  });

  it('logs rotate with appId, webhookId and url but never the secret', async () => {
    const response = await rotateAction(rotateArgs());
    const { signingSecret } = await readJson(response);

    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [, context] = mocks.logInfo.mock.calls[0]!;
    expect(context).toEqual({ appId: 'app_1', webhookId: 'wh_1', url: 'https://example.com/hook' });
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(signingSecret);
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(STORED_SECRET);
  });

  it('answers 404 app_not_found for an unknown app', async () => {
    mocks.getAppById.mockResolvedValue(null);

    const response = await rotateAction(rotateArgs({ appId: 'nope' }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(404);
    expect(data.error.code).toBe('app_not_found');
    expectNoStore(response);
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
  });

  it('answers 404 webhook_not_found when the webhook is missing or belongs to another app', async () => {
    mocks.getWebhookById.mockResolvedValue(null);

    const response = await rotateAction(rotateArgs({ webhookId: 'other' }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(404);
    expect(data.error.code).toBe('webhook_not_found');
    expectNoStore(response);
    expect(mocks.getWebhookById).toHaveBeenCalledWith('other', 'app_1', expect.anything());
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'DELETE'])('answers 405 for %s', async (method) => {
    const response = await rotateAction(rotateArgs({ method }));

    expect((response as Response).status).toBe(405);
    expect((response as Response).headers.get('Allow')).toBe('POST');
    expectNoStore(response);
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
  });

  it('answers 405 for GET', async () => {
    const response = await rotateLoader();

    expect((response as Response).status).toBe(405);
    expect((response as Response).headers.get('Allow')).toBe('POST');
    expectNoStore(response);
  });

  it('answers 500 without leaking details when the update fails', async () => {
    mocks.updateWebhook.mockRejectedValue(new Error('db exploded'));

    const response = await rotateAction(rotateArgs());
    const data = await readJson(response);

    expect((response as Response).status).toBe(500);
    expect(JSON.stringify(data)).not.toContain('db exploded');
    expectNoStore(response);
  });
});

describe('POST /v1/admin/apps/:id/webhooks target rules (PIGEON_WEBHOOK_PRIVATE_TARGETS)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers 422 for a host that resolves to a private address under deny, and creates nothing', async () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'deny');
    mockLookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }]);

    const response = await createAction(createArgs({ url: 'https://hooks.example.com/x', eventTypes: ['*'] }));
    const data = await readJson(response);

    expect((response as Response).status).toBe(422);
    expect(data.error.code).toBe('validation_error');
    expect(data.error.issues).toEqual([
      { code: 'custom', path: ['url'], message: 'URL must not point to a private or local address (10.0.0.5)' },
    ]);
    expect(mockLookup).toHaveBeenCalledWith('hooks.example.com', { all: true, verbatim: true });
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it('creates the webhook under deny when every address is public', async () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'deny');
    mockLookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);

    const response = await createAction(createArgs({ url: 'https://hooks.example.com/x', eventTypes: ['*'] }));

    expect((response as Response).status).toBe(201);
    expect(mocks.createWebhook).toHaveBeenCalledTimes(1);
  });

  it('answers 422 for a private address while the setting is unset (the default is deny)', async () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', '');
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    const response = await createAction(createArgs({ url: 'https://receiver.internal.example/x', eventTypes: ['*'] }));

    expect((response as Response).status).toBe(422);
    expect(mockLookup).toHaveBeenCalledWith('receiver.internal.example', { all: true, verbatim: true });
    expect(mocks.createWebhook).not.toHaveBeenCalled();
  });

  it('creates the webhook without a lookup under allow', async () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    const response = await createAction(createArgs({ url: 'https://receiver.internal.example/x', eventTypes: ['*'] }));

    expect((response as Response).status).toBe(201);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
