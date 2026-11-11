/**
 * Bearer admin API for inbound mail and the webhook event-type PATCH.
 * Models, S3 and pg-boss are mocked; no database needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAppById: vi.fn(),
  listInboundDomains: vi.fn(),
  createInboundDomain: vi.fn(),
  listInboundEmails: vi.fn(),
  getInboundEmail: vi.fn(),
  getWebhookById: vi.fn(),
  updateWebhook: vi.fn(),
  s3ObjectExists: vi.fn(),
  send: vi.fn(),
}));

vi.mock('#app/models/config-change.server', () => import('./support/config-change-passthrough'));
vi.mock('#drizzle/db', () => ({ db: {} }));
vi.mock('#app/models/apps.server', () => ({ getAppById: (...a: unknown[]) => mocks.getAppById(...a) }));
vi.mock('#app/models/inbound-domains.server', () => ({
  listInboundDomains: (...a: unknown[]) => mocks.listInboundDomains(...a),
  createInboundDomain: (...a: unknown[]) => mocks.createInboundDomain(...a),
}));
vi.mock('#app/models/inbound-emails.server', () => ({
  listInboundEmails: (...a: unknown[]) => mocks.listInboundEmails(...a),
  getInboundEmail: (...a: unknown[]) => mocks.getInboundEmail(...a),
}));
vi.mock('#app/models/webhooks.server', () => ({
  getWebhookById: (...a: unknown[]) => mocks.getWebhookById(...a),
  updateWebhook: (...a: unknown[]) => mocks.updateWebhook(...a),
}));
vi.mock('#app/lib/s3-client', () => ({
  s3ObjectExists: (...a: unknown[]) => mocks.s3ObjectExists(...a),
  openS3Object: vi.fn(),
  isS3NotFound: () => false,
}));
vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => ({ send: (...a: unknown[]) => mocks.send(...a) }) }),
}));
vi.mock('#app/lib/logger', () => ({
  createComponentLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const domainsRoute = await import('../app/routes/api.v1.admin.apps.$id.inbound-domains');
const webhookRoute = await import('../app/routes/api.v1.admin.apps.$id.webhooks.$webhookId');
const emailsRoute = await import('../app/routes/api.v1.admin.apps.$id.inbound-emails');
const replayRoute = await import('../app/routes/api.v1.admin.apps.$id.inbound-emails.$inboundEmailId.replay');

const NOW = new Date('2026-11-09T10:00:00Z');
const DOMAIN_ROW = { id: 'dom_1', appId: 'app_1', name: 'reply.example.test', region: 'eu-central-1', enabled: true, createdAt: NOW, updatedAt: NOW };
const SECRET = 'stored-secret-must-never-leak-0123456789abcdef';
const WEBHOOK_ROW = {
  id: 'wh_1', appId: 'app_1', url: 'https://example.com/hook', signingSecret: SECRET, eventTypes: ['email.bounced'],
  enabled: true, lastSuccessAt: null, lastFailureAt: null, createdAt: NOW, updatedAt: NOW,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

function req(path: string, init: { method?: string; body?: unknown; raw?: string } = {}): Request {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: hasBody ? (init.raw ?? JSON.stringify(init.body ?? {})) : undefined,
  });
}

async function body(res: unknown): Promise<any> {
  expect(res).toBeInstanceOf(Response);
  expect((res as Response).headers.get('Cache-Control')).toBe('no-store');
  return (res as Response).json();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAppById.mockResolvedValue({ id: 'app_1', name: 'App' });
});

describe('inbound domains', () => {
  it('lists the app domains', async () => {
    mocks.listInboundDomains.mockResolvedValue([DOMAIN_ROW]);
    const res = await domainsRoute.loader({ request: req('/v1/admin/apps/app_1/inbound-domains'), params: { id: 'app_1' } } as AnyArgs);
    expect(await body(res)).toEqual({ inboundDomains: [{ ...DOMAIN_ROW, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }] });
    expect(mocks.listInboundDomains).toHaveBeenCalledWith({ appId: 'app_1' });
  });

  it('adds a domain lower case', async () => {
    mocks.createInboundDomain.mockResolvedValue(DOMAIN_ROW);
    const res = await domainsRoute.action({
      request: req('/v1/admin/apps/app_1/inbound-domains', { method: 'POST', body: { name: ' Reply.Example.TEST ' } }),
      params: { id: 'app_1' },
    } as AnyArgs);
    expect((res as Response).status).toBe(201);
    expect((await body(res)).inboundDomain.name).toBe('reply.example.test');
    expect(mocks.createInboundDomain).toHaveBeenCalledWith({ appId: 'app_1', name: 'reply.example.test', db: expect.anything() });
  });

  it('rejects a non-hostname with 422 and a taken name with 409', async () => {
    const bad = await domainsRoute.action({
      request: req('/v1/admin/apps/app_1/inbound-domains', { method: 'POST', body: { name: '*.example.test' } }),
      params: { id: 'app_1' },
    } as AnyArgs);
    expect((bad as Response).status).toBe(422);

    mocks.createInboundDomain.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const dup = await domainsRoute.action({
      request: req('/v1/admin/apps/app_1/inbound-domains', { method: 'POST', body: { name: 'reply.example.test' } }),
      params: { id: 'app_1' },
    } as AnyArgs);
    expect((dup as Response).status).toBe(409);
    expect((await body(dup)).error.code).toBe('inbound_domain_exists');
  });

  it('answers 404 for an unknown app', async () => {
    mocks.getAppById.mockResolvedValue(null);
    const res = await domainsRoute.action({
      request: req('/v1/admin/apps/nope/inbound-domains', { method: 'POST', body: { name: 'reply.example.test' } }),
      params: { id: 'nope' },
    } as AnyArgs);
    expect((res as Response).status).toBe(404);
    expect(mocks.createInboundDomain).not.toHaveBeenCalled();
  });
});

describe('PATCH webhook event types', () => {
  function patch(payload: unknown, raw?: string) {
    return webhookRoute.action({
      request: req('/v1/admin/apps/app_1/webhooks/wh_1', { method: 'PATCH', body: payload, raw }),
      params: { id: 'app_1', webhookId: 'wh_1' },
    } as AnyArgs);
  }

  it('replaces the event types and never returns the signing secret', async () => {
    mocks.getWebhookById.mockResolvedValue(WEBHOOK_ROW);
    mocks.updateWebhook.mockResolvedValue({ ...WEBHOOK_ROW, eventTypes: ['email.bounced', 'email.received'] });
    const res = await patch({ eventTypes: ['email.bounced', 'email.received', 'email.received'] });
    expect((res as Response).status).toBe(200);
    const text = JSON.stringify(await body(res));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('signingSecret');
    expect(mocks.updateWebhook).toHaveBeenCalledWith('wh_1', 'app_1', { eventTypes: ['email.bounced', 'email.received'] }, expect.anything());
  });

  it('refuses unknown event types, extra fields and other methods', async () => {
    expect((await patch({ eventTypes: ['email.nope'] }) as Response).status).toBe(422);
    expect((await patch({ eventTypes: ['*'], signingSecret: 'x' }) as Response).status).toBe(422);
    expect((await patch(undefined, 'not json') as Response).status).toBe(400);
    const post = await webhookRoute.action({
      request: req('/v1/admin/apps/app_1/webhooks/wh_1', { method: 'POST', body: {} }),
      params: { id: 'app_1', webhookId: 'wh_1' },
    } as AnyArgs);
    expect((post as Response).status).toBe(405);
    expect(mocks.updateWebhook).not.toHaveBeenCalled();
  });

  it('answers 404 for a webhook of another app', async () => {
    mocks.getWebhookById.mockResolvedValue(null);
    expect((await patch({ eventTypes: ['*'] }) as Response).status).toBe(404);
  });
});

describe('inbound emails list and replay', () => {
  it('lists ids, times and counts only', async () => {
    mocks.listInboundEmails.mockResolvedValue([{ id: 'ie_1', inboundDomainId: 'dom_1', receivedAt: NOW, recipientCount: 1, createdAt: NOW }]);
    const res = await emailsRoute.loader({ request: req('/v1/admin/apps/app_1/inbound-emails?limit=5'), params: { id: 'app_1' } } as AnyArgs);
    const json = await body(res);
    expect(Object.keys(json.inboundEmails[0]).sort()).toEqual(['createdAt', 'id', 'inboundDomainId', 'receivedAt', 'recipientCount']);
    expect(mocks.listInboundEmails).toHaveBeenCalledWith({ appId: 'app_1', limit: 5 });

    const bad = await emailsRoute.loader({ request: req('/v1/admin/apps/app_1/inbound-emails?limit=0'), params: { id: 'app_1' } } as AnyArgs);
    expect((bad as Response).status).toBe(422);
  });

  function replay() {
    return replayRoute.action({
      request: req('/v1/admin/apps/app_1/inbound-emails/ie_1/replay', { method: 'POST' }),
      params: { id: 'app_1', inboundEmailId: 'ie_1' },
    } as AnyArgs);
  }

  it('queues inbound.process again with ids only', async () => {
    mocks.getInboundEmail.mockResolvedValue({ id: 'ie_1', appId: 'app_1', s3Bucket: 'b', s3Key: 'k' });
    mocks.s3ObjectExists.mockResolvedValue(true);
    mocks.send.mockResolvedValue('job-9');
    const res = await replay();
    expect((res as Response).status).toBe(202);
    expect(await body(res)).toEqual({ inboundEmailId: 'ie_1', jobId: 'job-9' });
    expect(mocks.getInboundEmail).toHaveBeenCalledWith({ appId: 'app_1', id: 'ie_1' });
    expect(mocks.send).toHaveBeenCalledWith('inbound.process', { inboundEmailId: 'ie_1', appId: 'app_1' }, expect.any(Object));
  });

  it('answers 404 when the row is gone and 410 when the raw mail expired', async () => {
    mocks.getInboundEmail.mockResolvedValue(null);
    expect((await replay() as Response).status).toBe(404);

    mocks.getInboundEmail.mockResolvedValue({ id: 'ie_1', appId: 'app_1', s3Bucket: 'b', s3Key: 'k' });
    mocks.s3ObjectExists.mockResolvedValue(false);
    const gone = await replay();
    expect((gone as Response).status).toBe(410);
    expect((await body(gone)).error.code).toBe('raw_mail_expired');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
