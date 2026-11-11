/**
 * webhook-deliver: target rules on both queues (webhook.deliver and
 * webhook.deliver.inbound).
 *
 * The first blocks drive the registered handlers with the real setting
 * (PIGEON_WEBHOOK_PRIVATE_TARGETS) and node:dns mocked, so no lookup leaves
 * the process and global fetch is a stub. The last block replaces the address
 * rule to reach a loopback test server through the pinned transport.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const dbSet = vi.hoisted(() => vi.fn((_values: Record<string, unknown>) => ({ where: async () => undefined })));
vi.mock('#drizzle/db', () => ({
  db: { update: () => ({ set: dbSet }) },
}));

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: mockLookup }));

import { __test__, type WebhookDeliverOutput } from '../webhook-deliver';
import type { AddressRule } from '#app/lib/webhook-target';

type Handler = (jobs: Parameters<typeof __test__.handleWebhookDeliver>[0]) => Promise<WebhookDeliverOutput | undefined>;

/**
 * A refused target ends the job without a throw, so pg-boss runs no retry. The
 * job output carries the reason.
 */
async function expectRefused(attempt: Promise<WebhookDeliverOutput | undefined>, reason: RegExp): Promise<void> {
  const output = await attempt;
  expect(output?.outcome).toBe('refused');
  expect(output?.message).toMatch(/^Target refused: /);
  expect(output?.message).toMatch(reason);
}

const HANDLERS: Array<[string, Handler]> = [
  ['webhook.deliver', __test__.handleWebhookDeliver],
  ['webhook.deliver.inbound', __test__.handleInboundWebhookDeliver],
];

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

const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok', { status: 200 }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockClear();
  mockLookup.mockReset();
  dbSet.mockClear();
});

describe.each(HANDLERS)('%s with PIGEON_WEBHOOK_PRIVATE_TARGETS=deny', (_queue, handle) => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'deny');
  });

  it.each([
    ['10.0.0.5', 4],
    ['100.64.0.3', 4],
    ['169.254.169.254', 4],
    ['fd00::7', 6],
    ['::ffff:127.0.0.1', 6],
  ])('refuses a host that resolves to %s and sends nothing', async (address, family) => {
    mockLookup.mockResolvedValue([{ address, family }]);
    await expectRefused(handle(job('https://hooks.example.com/x')), /non-public address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLookup).toHaveBeenCalledWith('hooks.example.com', { all: true, verbatim: true });
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'http://0x7f.1/x', 'http://[::ffff:a00:1]/x', 'http://2130706433/x'])(
    'refuses the IP literal %s without a lookup',
    async (url) => {
      await expectRefused(handle(job(url)), /non-public address/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockLookup).not.toHaveBeenCalled();
    },
  );

  it('fails the attempt when the host does not resolve', async () => {
    mockLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND nx.example.com'), { code: 'ENOTFOUND' }));
    await expect(handle(job('https://nx.example.com/x'))).rejects.toThrow(/ENOTFOUND/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe.each(HANDLERS)('%s while PIGEON_WEBHOOK_PRIVATE_TARGETS is unset (the default is deny)', (_queue, handle) => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', '');
  });

  it.each([
    ['10.0.0.5', 4],
    ['100.64.0.9', 4],
  ])('refuses a host that resolves to %s and sends nothing', async (address, family) => {
    mockLookup.mockResolvedValue([{ address, family }]);
    await expectRefused(handle(job('https://receiver.tailnet.example/hook')), /non-public address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a private IP literal without a lookup', async () => {
    await expectRefused(handle(job('http://100.64.0.9:8080/hook')), /non-public address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

describe.each(HANDLERS)('%s with PIGEON_WEBHOOK_PRIVATE_TARGETS=allow', (_queue, handle) => {
  beforeEach(() => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
  });

  it.each(['http://internal-receiver:3000/hook', 'https://receiver.tailnet.example/hook', 'http://100.64.0.9:8080/hook'])(
    'delivers to the private target %s with fetch',
    async (url) => {
      await handle(job(url));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
      expect(mockLookup).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ftp://hooks.example.com/x', /http or https/],
    ['https://user:pw@hooks.example.com/x', /username or password/],
  ])('still refuses %s before any request under allow', async (url, reason) => {
    await expectRefused(handle(job(url)), reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the pinned transport under deny, against a loopback server', () => {
  let server: Server | undefined;
  const received: IncomingMessage[] = [];

  afterEach(async () => {
    received.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
    server = createServer((req, res) => {
      received.push(req);
      req.resume();
      handler(req, res);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function deliver(opts: { url: string; isAllowedAddress?: AddressRule }) {
    return __test__.deliverWebhookJob({
      jobs: job(opts.url),
      includeResponseSnippet: true,
      deps: {
        resolvePolicy: () => 'deny',
        resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
        resolveAddressRule: () => opts.isAllowedAddress ?? (({ address }) => address === '127.0.0.1'),
      },
    });
  }

  it('delivers the signed POST to the pinned address', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    await deliver({ url: `http://hooks.invalid:${port}/x` });
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.headers['pigeon-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends a refused target at the first attempt: no throw, no request, a failure stamp', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    const output = await deliver({ url: `http://hooks.invalid:${port}/x`, isAllowedAddress: () => false });
    expect(output).toEqual({
      outcome: 'refused',
      message: 'Target refused: hooks.invalid resolves to a non-public address (127.0.0.1)',
    });
    expect(received).toHaveLength(0);
    expect(dbSet).toHaveBeenCalledTimes(1);
    expect(dbSet.mock.calls[0]?.[0]).toEqual({ lastFailureAt: expect.any(Date) });
  });

  it('still throws on a network failure, so pg-boss retries it', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(deliver({ url: `http://hooks.invalid:${port}/x` })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('fails on a redirect and never requests the Location', async () => {
    const port = await listen((req, res) => {
      if (req.url !== '/x') {
        res.end('followed');
        return;
      }
      res.writeHead(307, { Location: `http://hooks.invalid:${port}/elsewhere` });
      res.end();
    });
    await expect(deliver({ url: `http://hooks.invalid:${port}/x` })).rejects.toThrow('HTTP 307 (redirects are not followed)');
    expect(received.map((req) => req.url)).toEqual(['/x']);
  });

  it('reports a receiver error with a snippet of its answer', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500);
      res.end('x'.repeat(1_000));
    });
    await expect(deliver({ url: `http://hooks.invalid:${port}/x` })).rejects.toThrow(`HTTP 500: ${'x'.repeat(200)}`);
  });
});
