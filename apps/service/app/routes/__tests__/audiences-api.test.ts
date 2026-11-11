/**
 * Integration test: POST /v1/audiences + GET /v1/audiences flow (mock DB)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiKeyContext } from '#app/middleware/api-key-context';
import type { Route as AudiencesRoute } from '../+types/api.v1.audiences';

// DB mock: configurable select, insert returns row
let dbSelectReturns: unknown[] = [];

vi.mock('#app/models/config-change.server', () => import('../../../test/support/config-change-passthrough'));
vi.mock('#drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => [{ id: 'aud_test_1', ...row as object }],
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => dbSelectReturns,
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => [],
      }),
    }),
  },
}));

function makeContext(appId = 'app-1') {
  return { get: () => ({ appId, apiKeyId: 'key-1', rateLimitPerSecond: 10 }) };
}

const { action, loader } = await import('../api.v1.audiences');

function makePostRequest(body: unknown): Request {
  return new Request('http://localhost/v1/audiences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-id': 'app-1' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dbSelectReturns = [];
});

describe('POST /v1/audiences', () => {
  it('returns 201 with created audience', async () => {
    const req = makePostRequest({ name: 'Newsletter List' });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.ActionArgs);

    expect(response.status).toBe(201);
    const body = await response.json() as { audience: { id: string; name: string } };
    expect(body.audience.id).toBe('aud_test_1');
    expect(body.audience.name).toBe('Newsletter List');
  });

  it('returns 400 for missing name', async () => {
    const req = makePostRequest({});

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.ActionArgs);

    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost/v1/audiences', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-app-id': 'app-1' },
      body: 'not json',
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.ActionArgs);

    expect(response.status).toBe(400);
  });

  it('returns 405 for non-POST method', async () => {
    const req = new Request('http://localhost/v1/audiences', {
      method: 'PUT',
      headers: { 'x-app-id': 'app-1' },
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.ActionArgs);

    expect(response.status).toBe(405);
  });
});

describe('GET /v1/audiences', () => {
  it('returns 200 with empty audiences array when none exist', async () => {
    dbSelectReturns = [];

    const req = new Request('http://localhost/v1/audiences', {
      headers: { 'x-app-id': 'app-1' },
    });

    const response = await loader({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.LoaderArgs);

    expect(response.status).toBe(200);
    const body = await response.json() as { audiences: unknown[] };
    expect(Array.isArray(body.audiences)).toBe(true);
    expect(body.audiences).toHaveLength(0);
  });

  it('returns 200 with audience list when audiences exist', async () => {
    dbSelectReturns = [
      { id: 'aud_1', appId: 'app-1', name: 'List A' },
      { id: 'aud_2', appId: 'app-1', name: 'List B' },
    ];

    const req = new Request('http://localhost/v1/audiences', {
      headers: { 'x-app-id': 'app-1' },
    });

    const response = await loader({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as AudiencesRoute.LoaderArgs);

    expect(response.status).toBe(200);
    const body = await response.json() as { audiences: unknown[] };
    expect(body.audiences).toHaveLength(2);
  });
});
