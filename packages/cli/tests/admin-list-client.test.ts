import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { PigeonClient, PigeonHttpError, isMissingRouteError } from '../src/lib/pigeon-client.js';

const client = new PigeonClient({ baseUrl: 'http://pigeon.test' });
const ARGS = { adminSecret: 'admin', appId: 'app_1' };
const NOT_FOUND_PAGE = '<!DOCTYPE html><html><body>404</body></html>';
const APP_NOT_FOUND = JSON.stringify({ error: { code: 'app_not_found', message: 'App not found' } });

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

describe('admin domain and audience lists', () => {
  it('listAppDomains reads GET /v1/admin/apps/:id/domains with the admin secret', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ domains: [{ id: 'dom_1', name: 'example.test' }] }));
    const { domains } = await client.listAppDomains(ARGS);

    assert.equal(domains[0]?.id, 'dom_1');
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/domains');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer admin');
  });

  it('listAppAudiences reads GET /v1/admin/apps/:id/audiences', async () => {
    const { calls } = stubFetch(200, JSON.stringify({ audiences: [{ id: 'aud_1', name: 'news' }] }));
    const { audiences } = await client.listAppAudiences(ARGS);

    assert.equal(audiences[0]?.id, 'aud_1');
    assert.equal(calls[0]?.url, 'http://pigeon.test/v1/admin/apps/app_1/audiences');
  });
});

describe('isMissingRouteError', () => {
  it('is true for the 404 page an older server answers for an unknown path', async () => {
    stubFetch(404, NOT_FOUND_PAGE);
    const error = await caught(client.listAppDomains(ARGS));
    assert.ok(error instanceof PigeonHttpError);
    assert.equal(error.status, 404);
    assert.equal(error.code, null);
    assert.equal(isMissingRouteError(error), true);
  });

  it('is false for a 404 with the app_not_found code', async () => {
    stubFetch(404, APP_NOT_FOUND);
    const error = await caught(client.listAppAudiences(ARGS));
    assert.ok(error instanceof PigeonHttpError);
    assert.equal(error.code, 'app_not_found');
    assert.equal(isMissingRouteError(error), false);
  });

  it('is false for other statuses and for errors that are not HTTP errors', async () => {
    for (const status of [401, 500, 502]) {
      stubFetch(status, NOT_FOUND_PAGE);
      assert.equal(isMissingRouteError(await caught(client.listAppDomains(ARGS))), false, String(status));
      mock.restoreAll();
    }
    assert.equal(isMissingRouteError(new Error('Pigeon API error 404 on GET /x: nope')), false);
  });

  it('keeps the message format of a failed read', async () => {
    stubFetch(404, NOT_FOUND_PAGE);
    const error = await caught(client.listAppDomains(ARGS));
    assert.match(String((error as Error).message), /^Pigeon API error 404 on GET \/v1\/admin\/apps\/app_1\/domains: <!DOCTYPE/);
  });
});
