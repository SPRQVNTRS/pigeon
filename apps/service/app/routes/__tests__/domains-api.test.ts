/**
 * Integration test: POST /v1/domains flow (mock SES + mock DB)
 *
 * Validates that:
 * - action() persists a row, calls CreateEmailIdentityCommand, enqueues domain.verify job
 * - responds with { id, dnsRecords }
 * - app-scoping: different appId cannot access another app's domain
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  PutEmailIdentityDkimSigningAttributesCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
} from '@aws-sdk/client-sesv2';
import { resetSesClients } from '#app/lib/ses/client';
import { apiKeyContext } from '#app/middleware/api-key-context';
import type { Route as DomainsRoute } from '../+types/api.v1.domains';
import type { Route as DomainsIdRoute } from '../+types/api.v1.domains.$id';

// --- Mock pg-boss and DB before importing route ---
const mockSend = vi.fn().mockResolvedValue(null);
const mockBoss = { send: mockSend };

vi.mock('#app/models/config-change.server', () => import('../../../test/support/config-change-passthrough'));
vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => mockBoss }),
}));

// DB mock with configurable select behavior
let selectReturns: unknown[] = [];
vi.mock('#drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => [{ id: 'dom_test_1', ...row as object }],
      }),
    }),
    select: () => ({
      from: () => ({
        where: async () => selectReturns,
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  },
}));

const sesMock = mockClient(SESv2Client);
const TOKENS = ['tok1', 'tok2', 'tok3'];

beforeEach(() => {
  sesMock.reset();
  resetSesClients();
  mockSend.mockClear();
  selectReturns = [];

  sesMock.on(CreateEmailIdentityCommand).resolves({});
  sesMock.on(PutEmailIdentityDkimSigningAttributesCommand).resolves({});
  sesMock.on(GetEmailIdentityCommand).resolves({
    VerifiedForSendingStatus: false,
    DkimAttributes: { Status: 'PENDING', Tokens: TOKENS, SigningEnabled: true },
  });
  sesMock.on(DeleteEmailIdentityCommand).resolves({});
});

afterEach(() => {
  sesMock.reset();
  resetSesClients();
});

/**
 * Build a minimal context stub that satisfies context.get(apiKeyContext).
 * Cast to the generated Route arg type at call sites to avoid constructing
 * the full unstable_url/unstable_pattern fields that typegen adds.
 */
function makeContext(appId = 'app-1') {
  const store = new Map<object, unknown>();
  store.set(apiKeyContext, { apiKeyId: 'key-1', appId, rateLimitPerSecond: 10 });
  return { get: (key: object) => store.get(key) };
}

// Import route action after mocks are in place
const { action } = await import('../api.v1.domains');

function makeRequest(body: unknown, appId = 'app-1'): Request {
  return new Request('http://localhost/v1/domains', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-id': appId,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/domains', () => {
  it('returns 201 with id and dnsRecords on success', async () => {
    const req = makeRequest({ name: 'mail.example.com' });
    const response = await action(
      { request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs,
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; dnsRecords: unknown[] };
    expect(body.id).toBe('dom_test_1');
    expect(Array.isArray(body.dnsRecords)).toBe(true);
    expect(body.dnsRecords.length).toBeGreaterThan(0);
  });

  it('calls CreateEmailIdentityCommand with the domain name', async () => {
    const req = makeRequest({ name: 'mail.example.com' });
    await action({ request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs);

    const createCall = sesMock.calls().find((c) => c.args[0] instanceof CreateEmailIdentityCommand);
    expect(createCall).toBeDefined();
    expect(createCall?.args[0].input).toMatchObject({ EmailIdentity: 'mail.example.com' });
  });

  it('enqueues a domain.verify job with singletonKey', async () => {
    const req = makeRequest({ name: 'mail.example.com' });
    await action({ request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs);

    expect(mockSend).toHaveBeenCalledWith(
      'domain.verify',
      expect.objectContaining({ domainId: 'dom_test_1' }),
      expect.objectContaining({ singletonKey: 'dom_test_1' }),
    );
  });

  it('returns 422 for missing name', async () => {
    const req = makeRequest({});
    const response = await action(
      { request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs,
    );
    expect(response.status).toBe(422);
  });

  it('returns 400 for non-JSON body', async () => {
    const req = new Request('http://localhost/v1/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-app-id': 'app-1' },
      body: 'not json',
    });
    const response = await action(
      { request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs,
    );
    expect(response.status).toBe(400);
  });

  it('returns 405 for non-POST method', async () => {
    const req = new Request('http://localhost/v1/domains', {
      method: 'PUT',
      headers: { 'x-app-id': 'app-1' },
    });
    const response = await action(
      { request: req, context: makeContext(), params: {} } as unknown as DomainsRoute.ActionArgs,
    );
    expect(response.status).toBe(405);
  });
});

describe('app-scoping: GET /v1/domains/:id', () => {
  it('returns 404 when domain belongs to a different appId (select returns empty)', async () => {
    // Domain exists for app-1, but this request comes from app-2.
    // The db mock's where() returns selectReturns — we leave it empty
    // to simulate the appId filter finding no results.
    selectReturns = [];

    const { loader } = await import('../api.v1.domains.$id');

    const req = new Request('http://localhost/v1/domains/dom_1', {
      headers: { 'x-app-id': 'app-2' },
    });
    const response = await loader(
      { request: req, params: { id: 'dom_1' }, context: makeContext('app-2') } as unknown as DomainsIdRoute.LoaderArgs,
    );
    expect(response.status).toBe(404);
  });

  it('returns 200 when domain belongs to the requesting appId (select returns the row)', async () => {
    selectReturns = [{ id: 'dom_1', appId: 'app-1', name: 'mail.example.com', region: 'eu-central-1', dkimTokens: TOKENS }];

    const { loader } = await import('../api.v1.domains.$id');

    const req = new Request('http://localhost/v1/domains/dom_1', {
      headers: { 'x-app-id': 'app-1' },
    });
    const response = await loader(
      { request: req, params: { id: 'dom_1' }, context: makeContext('app-1') } as unknown as DomainsIdRoute.LoaderArgs,
    );
    expect(response.status).toBe(200);
  });
});
