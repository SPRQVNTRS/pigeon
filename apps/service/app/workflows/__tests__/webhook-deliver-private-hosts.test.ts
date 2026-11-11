/**
 * webhook-deliver: PIGEON_WEBHOOK_PRIVATE_HOSTS at delivery time, on both
 * queues, through the registered handlers and the real settings.
 *
 * node:dns is mocked, so no lookup leaves the process. node:https.request is
 * replaced by a stand-in that runs the pinned lookup the way a socket connect
 * does and then answers 204, so an allowed private address is never dialled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { LookupFunction } from 'node:net';

const dbSet = vi.hoisted(() => vi.fn((_values: Record<string, unknown>) => ({ where: async () => undefined })));
vi.mock('#drizzle/db', () => ({
  db: { update: () => ({ set: dbSet }) },
}));

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest, default: { ...actual, request: httpsRequest } };
});

import { __test__, type WebhookDeliverOutput } from '../webhook-deliver';

type Handler = (jobs: Parameters<typeof __test__.handleWebhookDeliver>[0]) => Promise<WebhookDeliverOutput | undefined>;

const HANDLERS: Array<[string, Handler]> = [
  ['webhook.deliver', __test__.handleWebhookDeliver],
  ['webhook.deliver.inbound', __test__.handleInboundWebhookDeliver],
];

/** The addresses each stand-in connect was handed by the pinned lookup. */
const connectedTo: unknown[] = [];

function fakeHttpsRequest(url: URL, options: { lookup: LookupFunction }, onResponse: (res: unknown) => void) {
  const req = Object.assign(new EventEmitter(), {
    end: () => {
      options.lookup(url.hostname, { all: true }, ((err: NodeJS.ErrnoException | null, addresses: unknown) => {
        if (err) {
          req.emit('error', err);
          return;
        }
        connectedTo.push(addresses);
        onResponse({ statusCode: 204, destroy: () => undefined });
      }) as never);
    },
  });
  return req;
}

function job(url: string) {
  return [
    {
      data: {
        webhookId: 'wh_1',
        url,
        signingSecret: 'secret',
        eventType: 'email.bounced',
        payload: { id: 'evt_1', type: 'email.bounced' },
      },
    },
  ];
}

const fetchMock = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }),
);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  httpsRequest.mockImplementation(fakeHttpsRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockClear();
  mockLookup.mockReset();
  httpsRequest.mockReset();
  dbSet.mockClear();
  connectedTo.length = 0;
});

describe.each(HANDLERS)('%s with PIGEON_WEBHOOK_PRIVATE_HOSTS under the default deny', (_queue, handle) => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', '');
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', 'Hooks.Example.com, internal.example.org');
  });

  it('delivers to a listed host that resolves to a private network address, pinned to that address', async () => {
    mockLookup.mockResolvedValue([{ address: '100.64.0.3', family: 4 }]);
    expect(await handle(job('https://hooks.example.com/hook'))).toBeUndefined();
    expect(connectedTo).toEqual([[{ address: '100.64.0.3', family: 4 }]]);
    expect(dbSet.mock.calls[0]?.[0]).toEqual({ lastSuccessAt: expect.any(Date) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('matches a listed host written with a trailing dot in the URL', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    expect(await handle(job('https://internal.example.org./hook'))).toBeUndefined();
    expect(connectedTo).toHaveLength(1);
  });

  it.each(['127.0.0.1', '169.254.169.254', '::1', 'fe80::1'])(
    'refuses a listed host when one answer is %s, after one attempt',
    async (restricted) => {
      mockLookup.mockResolvedValue([
        { address: '100.64.0.3', family: 4 },
        { address: restricted, family: restricted.includes(':') ? 6 : 4 },
      ]);
      const output = await handle(job('https://hooks.example.com/hook'));
      expect(output).toEqual({
        outcome: 'refused',
        message: `Target refused: hooks.example.com resolves to a non-public address (${restricted})`,
      });
      expect(connectedTo).toHaveLength(0);
      expect(dbSet.mock.calls[0]?.[0]).toEqual({ lastFailureAt: expect.any(Date) });
    },
  );

  it('refuses a host that is not listed, after one attempt', async () => {
    mockLookup.mockResolvedValue([{ address: '100.64.0.3', family: 4 }]);
    expect((await handle(job('https://other.example.com/hook')))?.outcome).toBe('refused');
    expect(connectedTo).toHaveLength(0);
  });

  it('refuses a private IP literal without a lookup', async () => {
    expect((await handle(job('https://100.64.0.3/hook')))?.outcome).toBe('refused');
    expect(mockLookup).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('fails the job, so it is retried, when the list holds an invalid entry', async () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', 'hooks.example.com,*.example.org');
    mockLookup.mockResolvedValue([{ address: '100.64.0.3', family: 4 }]);
    await expect(handle(job('https://hooks.example.com/hook'))).rejects.toThrow(
      'PIGEON_WEBHOOK_PRIVATE_HOSTS must list exact host names such as hooks.example.com, but "*.example.org" is a wildcard',
    );
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});

describe.each(HANDLERS)('%s with PIGEON_WEBHOOK_PRIVATE_TARGETS=allow and a host list', (_queue, handle) => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', 'hooks.example.com');
  });

  it('ignores the list and delivers to any private target with fetch', async () => {
    expect(await handle(job('https://other.example.com/hook'))).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
