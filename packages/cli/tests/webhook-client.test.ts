import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  PigeonClient,
  PigeonHttpError,
  PigeonUnreadableResponseError,
  WebhookExistsError,
} from '../src/lib/pigeon-client.js';
import { SECRET, makeWebhook } from './webhook-test-helpers.js';

const client = new PigeonClient({ baseUrl: 'http://pigeon.test' });
const CREATE = { adminSecret: 'admin', appId: 'app_1', url: 'https://example.com/hook', eventTypes: ['*'] };

function stubFetch(status: number, body: string): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  });
  return { calls };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

afterEach(() => mock.restoreAll());

describe('webhook client', () => {
  it('createWebhook posts url and eventTypes and returns webhook plus secret', async () => {
    const { calls } = stubFetch(201, JSON.stringify({ webhook: makeWebhook(), signingSecret: SECRET }));
    const result = await client.createWebhook(CREATE);

    assert.equal(result.signingSecret, SECRET);
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/webhooks');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { url: CREATE.url, eventTypes: ['*'] });
  });

  it('rotateWebhookSecret posts to the rotate path', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ webhook: makeWebhook(), signingSecret: SECRET }));
    await client.rotateWebhookSecret({ adminSecret: 'admin', appId: 'app_1', webhookId: 'wh_1' });
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/webhooks/wh_1/rotate');
  });

  it('listWebhooks reads the webhooks array', async () => {
    stubFetch(200, JSON.stringify({ webhooks: [makeWebhook()] }));
    const { webhooks } = await client.listWebhooks({ adminSecret: 'admin', appId: 'app_1' });
    assert.equal(webhooks[0]?.id, 'wh_1');
  });

  it('409 throws WebhookExistsError with the existing id', async () => {
    stubFetch(
      409,
      JSON.stringify({ error: { code: 'webhook_exists', message: 'A webhook exists', webhookId: 'wh_existing' } }),
    );
    const error = await caught(client.createWebhook(CREATE));
    assert.ok(error instanceof WebhookExistsError);
    assert.equal(error.webhookId, 'wh_existing');
  });

  it('a 201 with malformed JSON does not echo the body', async () => {
    stubFetch(201, `{"webhook":{"id":"wh_1"},"signingSecret":"${SECRET}"`);
    const error = await caught(client.createWebhook(CREATE));
    assert.ok(error instanceof PigeonUnreadableResponseError);
    assert.ok(!error.message.includes(SECRET));
    assert.ok(!error.message.includes('signingSecret'));
  });

  it('a 200 with the wrong shape does not echo the body', async () => {
    stubFetch(200, JSON.stringify({ signingSecret: SECRET, webhook: 'nope' }));
    const error = await caught(
      client.rotateWebhookSecret({ adminSecret: 'admin', appId: 'app_1', webhookId: 'wh_1' }),
    );
    assert.ok(error instanceof PigeonUnreadableResponseError);
    assert.ok(!(error as Error).message.includes(SECRET));
  });

  it('an error status whose body carries the secret does not echo it', async () => {
    stubFetch(
      500,
      JSON.stringify({ error: { code: 'internal', message: `boom ${SECRET}` }, signingSecret: SECRET }),
    );
    const error = await caught(client.createWebhook(CREATE));
    assert.ok(error instanceof PigeonHttpError);
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes(SECRET));
    assert.ok(!error.message.includes('signingSecret'));
  });

  it('a plain-text error body is not echoed', async () => {
    stubFetch(502, `<html>proxy error ${SECRET}</html>`);
    const error = await caught(client.createWebhook(CREATE));
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(SECRET));
    assert.match(error.message, /502/);
  });

  it('422 keeps the code and message', async () => {
    stubFetch(422, JSON.stringify({ error: { code: 'validation_error', message: 'url must be https' } }));
    const error = await caught(client.createWebhook(CREATE));
    assert.ok(error instanceof PigeonHttpError);
    assert.match(error.message, /validation_error: url must be https/);
  });
});

describe('inbound and webhook update client', () => {
  it('updateWebhookEvents sends PATCH with eventTypes', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ webhook: makeWebhook({ eventTypes: ['email.received'] }) }));
    const { webhook } = await client.updateWebhookEvents({
      adminSecret: 'admin',
      appId: 'app_1',
      webhookId: 'wh_1',
      eventTypes: ['email.received'],
    });
    assert.deepEqual(webhook.eventTypes, ['email.received']);
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/webhooks/wh_1');
    assert.equal(calls[0]?.init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { eventTypes: ['email.received'] });
  });

  it('listInboundDomains and addInboundDomain use the inbound-domains path', async () => {
    const domain = { id: 'ind_1', appId: 'app_1', name: 'reply.example.test', region: 'eu-central-1', enabled: true, createdAt: 't', updatedAt: 't' };
    const listed = stubFetch(200, JSON.stringify({ inboundDomains: [domain] }));
    const { inboundDomains } = await client.listInboundDomains({ adminSecret: 'admin', appId: 'app_1' });
    assert.equal(inboundDomains[0]?.name, 'reply.example.test');
    assert.equal(listed.calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/inbound-domains');
    mock.restoreAll();

    const added = stubFetch(201, JSON.stringify({ inboundDomain: domain }));
    await client.addInboundDomain({ adminSecret: 'admin', appId: 'app_1', name: 'reply.example.test' });
    assert.equal(added.calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(added.calls[0]?.init?.body)), { name: 'reply.example.test' });
  });

  it('listInboundEmails passes the limit as a query parameter', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ inboundEmails: [] }));
    await client.listInboundEmails({ adminSecret: 'admin', appId: 'app_1', limit: 10 });
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/inbound-emails?limit=10');
    mock.restoreAll();

    const bare = stubFetch(200, JSON.stringify({ inboundEmails: [] }));
    await client.listInboundEmails({ adminSecret: 'admin', appId: 'app_1' });
    assert.equal(bare.calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/inbound-emails');
  });

  it('replayInboundEmail posts to the replay path, and a 410 surfaces its code', async () => {
    const ok = stubFetch(202, JSON.stringify({ inboundEmailId: 'ie_1', jobId: 'job_1' }));
    const replay = await client.replayInboundEmail({ adminSecret: 'admin', appId: 'app_1', inboundEmailId: 'ie_1' });
    assert.deepEqual(replay, { inboundEmailId: 'ie_1', jobId: 'job_1' });
    assert.equal(ok.calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/inbound-emails/ie_1/replay');
    assert.equal(ok.calls[0]?.init?.method, 'POST');
    mock.restoreAll();

    stubFetch(410, JSON.stringify({ error: { code: 'raw_mail_expired', message: 'gone' } }));
    const error = await caught(
      client.replayInboundEmail({ adminSecret: 'admin', appId: 'app_1', inboundEmailId: 'ie_1' }),
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /410/);
    assert.match(error.message, /raw_mail_expired/);
  });
});
