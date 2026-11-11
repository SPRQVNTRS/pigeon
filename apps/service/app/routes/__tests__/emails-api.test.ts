/**
 * Integration test: POST /v1/emails + GET /v1/emails flow (mock DB + mock pg-boss)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiKeyContext } from '#app/middleware/api-key-context';
import type { Route as EmailsRoute } from '../+types/api.v1.emails';

// --- Mocks must be declared before route imports ---

const mockBossSend = vi.fn().mockResolvedValue(null);

vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => ({ send: mockBossSend }) }),
}));

vi.mock('#app/lib/idempotency', () => ({
  checkIdempotency: vi.fn().mockResolvedValue({ type: 'fresh' }),
  hashBody: vi.fn().mockReturnValue('hash'),
  storeIdempotency: vi.fn().mockResolvedValue(undefined),
}));

// DB mock: insert returns the row, select is configurable
// Supports both:
//   .select().from().where().limit()         (getDomainByHostname, getEmail)
//   .select().from().where().orderBy().limit().offset()   (listEmails)
let dbSelectReturns: unknown[] = [];

const selectChain = () => ({
  limit: async () => dbSelectReturns,
  orderBy: () => ({
    limit: () => ({
      offset: async () => dbSelectReturns,
    }),
  }),
});

vi.mock('#drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => [{ id: 'email_test_1', status: 'queued', ...row as object }],
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => selectChain(),
        orderBy: () => ({
          limit: () => ({
            offset: async () => dbSelectReturns,
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
  },
}));

function makeContext(appId = 'app-1', apiKeyId = 'key-1') {
  return { get: () => ({ appId, apiKeyId, rateLimitPerSecond: 10 }) };
}

const { action, loader } = await import('../api.v1.emails');

function makePostRequest(body: unknown, appId = 'app-1'): Request {
  return new Request('http://localhost/v1/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-id': appId },
    body: JSON.stringify(body),
  });
}

const VERIFIED_DOMAIN = {
  id: 'dom_1',
  appId: 'app-1',
  name: 'mail.example.com',
  dkimStatus: 'verified',
  verifiedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectReturns = [];
});

describe('POST /v1/emails', () => {
  it('returns 201 with id and status queued for valid payload', async () => {
    // getDomainByHostname will hit db.select() — return verified domain
    dbSelectReturns = [VERIFIED_DOMAIN];

    const req = makePostRequest({
      from: 'sender@mail.example.com',
      to: ['recipient@example.com'],
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; status: string };
    expect(body.id).toBe('email_test_1');
    expect(body.status).toBe('queued');
    expect(mockBossSend).toHaveBeenCalledWith('email.send', expect.objectContaining({ emailId: 'email_test_1' }));
  });

  it('queues the job with retainBody true when retain_body is not sent', async () => {
    dbSelectReturns = [VERIFIED_DOMAIN];

    const response = await action({
      request: makePostRequest({
        from: 'sender@mail.example.com',
        to: ['recipient@example.com'],
        subject: 'Hello',
        html: '<p>Hi</p>',
      }),
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(201);
    expect(mockBossSend).toHaveBeenCalledWith('email.send', expect.objectContaining({ retainBody: true }));
  });

  it('queues the job with retainBody false when retain_body is false', async () => {
    dbSelectReturns = [VERIFIED_DOMAIN];

    const response = await action({
      request: makePostRequest({
        from: 'sender@mail.example.com',
        to: ['recipient@example.com'],
        subject: 'Reset your password',
        html: '<p>link</p>',
        retain_body: false,
      }),
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(201);
    expect(mockBossSend).toHaveBeenCalledWith('email.send', expect.objectContaining({ retainBody: false }));
  });

  it('returns 400 when retain_body is not a boolean', async () => {
    dbSelectReturns = [VERIFIED_DOMAIN];

    const response = await action({
      request: makePostRequest({
        from: 'sender@mail.example.com',
        to: ['recipient@example.com'],
        subject: 'Hello',
        html: '<p>Hi</p>',
        retain_body: 'no',
      }),
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(400);
  });

  it('returns 422 when domain is not verified', async () => {
    dbSelectReturns = [{ ...VERIFIED_DOMAIN, dkimStatus: 'pending', verifiedAt: null }];

    const req = makePostRequest({
      from: 'sender@mail.example.com',
      to: ['recipient@example.com'],
      subject: 'Hello',
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(422);
  });

  it('returns 422 when domain does not exist', async () => {
    dbSelectReturns = [];

    const req = makePostRequest({
      from: 'sender@unknown.example.com',
      to: ['recipient@example.com'],
      subject: 'Hello',
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(422);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new Request('http://localhost/v1/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-app-id': 'app-1' },
      body: 'not json',
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(400);
  });

  it('returns 400 for missing required fields', async () => {
    const req = makePostRequest({ from: 'sender@mail.example.com' });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(400);
  });

  it('returns 405 for non-POST method', async () => {
    const req = new Request('http://localhost/v1/emails', {
      method: 'PUT',
      headers: { 'x-app-id': 'app-1' },
    });

    const response = await action({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.ActionArgs);

    expect(response.status).toBe(405);
  });
});

describe('GET /v1/emails', () => {
  it('returns 200 with emails array', async () => {
    dbSelectReturns = [];

    const req = new Request('http://localhost/v1/emails', {
      headers: { 'x-app-id': 'app-1' },
    });

    const response = await loader({
      request: req,
      context: makeContext(),
      params: {},
    } as unknown as EmailsRoute.LoaderArgs);

    expect(response.status).toBe(200);
    const body = await response.json() as { emails: unknown[]; limit: number; offset: number };
    expect(Array.isArray(body.emails)).toBe(true);
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });
});
