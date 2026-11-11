/**
 * Webhook target rules (SSRF guard). Every resolver here is injected; nothing
 * touches the network except the loopback test server of the pinned transport.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkWebhookTarget,
  checkWebhookUrlShape,
  classifyAddress,
  createDenyAddressRule,
  createPinnedLookup,
  isPublicAddress,
  WebhookTargetRefusedError,
  type AddressRule,
  type ResolveHost,
  type ResolvedAddress,
} from '../webhook-target';
import { createPinnedTransport } from '../webhook-transport';

const NO_PRIVATE_HOSTS: ReadonlySet<string> = new Set();
const PRIVATE_HOSTS: ReadonlySet<string> = new Set(['hooks.example.com']);

const DENY = { policy: 'deny', privateHosts: NO_PRIVATE_HOSTS } as const;
const DENY_LISTED = { policy: 'deny', privateHosts: PRIVATE_HOSTS } as const;
const ALLOW = { policy: 'allow', privateHosts: NO_PRIVATE_HOSTS } as const;

/** The deny rule with an empty PIGEON_WEBHOOK_PRIVATE_HOSTS. */
const publicOnly: AddressRule = ({ address }) => isPublicAddress(address);

function resolverOf(...addresses: string[]): ResolveHost & ReturnType<typeof vi.fn> {
  return vi.fn(async () => addresses.map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 })));
}

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['172.31.255.255', 'private 172.16/12'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.254', 'CGNAT'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['febf::1', 'IPv6 link-local'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:a00:1', 'IPv4-mapped 10/8'],
    ['::ffff:6440:1', 'IPv4-mapped CGNAT'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['64:ff9b::7f00:1', 'NAT64 of loopback'],
    ['not-an-ip', 'not an address'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'accepts the public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('checkWebhookUrlShape (both settings)', () => {
  it.each(['https://hooks.example.com/x', 'http://hooks.example.com/x'])('accepts %s', (url) => {
    expect(checkWebhookUrlShape(url)).toEqual({ ok: true });
  });

  it.each([
    ['ftp://hooks.example.com/x', /http or https/],
    ['file:///etc/passwd', /http or https/],
    ['data:text/plain,hi', /http or https/],
    ['https://user:pw@hooks.example.com/x', /username or password/],
    ['https://user@hooks.example.com/x', /username or password/],
    ['not a url', /valid URL/],
  ])('refuses %s', (url, reason) => {
    const result = checkWebhookUrlShape(url);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
  });
});

describe('checkWebhookTarget under deny', () => {
  it('accepts a host whose every address is public', async () => {
    const resolveHost = resolverOf('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c');
    expect(await checkWebhookTarget({ url: 'https://hooks.example.com/x', ...DENY, resolveHost })).toEqual({ ok: true });
    expect(resolveHost).toHaveBeenCalledWith('hooks.example.com');
  });

  it('refuses a host when any one address is private', async () => {
    const resolveHost = resolverOf('93.184.215.14', '10.0.0.5');
    const result = await checkWebhookTarget({ url: 'https://hooks.example.com/x', ...DENY, resolveHost });
    expect(result).toEqual({ ok: false, reason: 'URL must not point to a private or local address (10.0.0.5)' });
  });

  it.each(['100.64.0.7', '169.254.169.254', '::1', 'fd00::5', '::ffff:192.168.0.1'])(
    'refuses a host that resolves to %s',
    async (address) => {
      const result = await checkWebhookTarget({ url: 'https://hooks.example.com/x', ...DENY, resolveHost: resolverOf(address) });
      expect(result.ok).toBe(false);
    },
  );

  it('refuses a host that does not resolve, or resolves to nothing', async () => {
    const failing: ResolveHost = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await checkWebhookTarget({ url: 'https://nx.example.com/', ...DENY, resolveHost: failing })).toEqual({
      ok: false,
      reason: 'nx.example.com could not be resolved',
    });
    expect((await checkWebhookTarget({ url: 'https://empty.example.com/', ...DENY, resolveHost: resolverOf() })).ok).toBe(false);
  });

  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f.1/',
    'http://127.1/',
    'http://0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[0:0:0:0:0:ffff:a00:1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0xa9fea9fe/',
  ])('refuses the IP literal %s without resolving', async (url) => {
    const resolveHost = resolverOf('93.184.215.14');
    const result = await checkWebhookTarget({ url, ...DENY, resolveHost });
    expect(result.ok).toBe(false);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('accepts a public IP literal', async () => {
    expect(await checkWebhookTarget({ url: 'https://93.184.215.14/x', ...DENY, resolveHost: resolverOf() })).toEqual({ ok: true });
  });
});

describe('checkWebhookTarget under allow', () => {
  it('lets a private target through without resolving', async () => {
    const resolveHost = resolverOf('10.0.0.5');
    expect(await checkWebhookTarget({ url: 'http://internal-receiver:3000/hook', ...ALLOW, resolveHost })).toEqual({ ok: true });
    expect(await checkWebhookTarget({ url: 'http://100.64.0.9/hook', ...ALLOW, resolveHost })).toEqual({ ok: true });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('still applies the scheme and credential rules', async () => {
    const resolveHost = resolverOf('10.0.0.5');
    expect((await checkWebhookTarget({ url: 'ftp://internal/x', ...ALLOW, resolveHost })).ok).toBe(false);
    expect((await checkWebhookTarget({ url: 'https://a:b@internal/x', ...ALLOW, resolveHost })).ok).toBe(false);
  });
});

describe('classifyAddress', () => {
  it.each([
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.254', 'private'],
    ['fd12:3456::1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['127.0.0.1', 'restricted'],
    ['::1', 'restricted'],
    ['169.254.169.254', 'restricted'],
    ['169.254.0.1', 'restricted'],
    ['fe80::1', 'restricted'],
    ['0.0.0.0', 'restricted'],
    ['::', 'restricted'],
    ['::ffff:127.0.0.1', 'restricted'],
    ['::ffff:169.254.169.254', 'restricted'],
    ['64:ff9b::a00:1', 'restricted'],
    ['224.0.0.1', 'restricted'],
    ['not-an-ip', 'restricted'],
    ['93.184.215.14', 'public'],
    ['2606:4700::1111', 'public'],
  ])('puts %s in the %s class', (address, addressClass) => {
    expect(classifyAddress(address)).toBe(addressClass);
  });
});

describe('createDenyAddressRule with PIGEON_WEBHOOK_PRIVATE_HOSTS', () => {
  const rule = createDenyAddressRule({ privateHosts: PRIVATE_HOSTS });

  it.each(['10.0.0.5', '172.16.4.2', '192.168.1.10', '100.64.0.7', 'fd00::5', '::ffff:192.168.0.1'])(
    'lets a listed host use the private network address %s',
    (address) => {
      expect(rule({ hostname: 'hooks.example.com', address })).toBe(true);
    },
  );

  const RESTRICTED = ['127.0.0.1', '::1', '169.254.169.254', '169.254.0.1', 'fe80::1', '0.0.0.0', '::', '::ffff:127.0.0.1'];
  it.each([...RESTRICTED, '64:ff9b::a00:1'])(
    'refuses the loopback, link-local, metadata or unspecified address %s for a listed host',
    (address) => {
      expect(rule({ hostname: 'hooks.example.com', address })).toBe(false);
    },
  );

  it('refuses a private address for a host that is not listed', () => {
    expect(rule({ hostname: 'other.example.com', address: '100.64.0.7' })).toBe(false);
    expect(rule({ hostname: 'sub.hooks.example.com', address: '100.64.0.7' })).toBe(false);
    expect(rule({ hostname: 'example.com', address: '100.64.0.7' })).toBe(false);
  });

  it('matches the host name without regard to case or a trailing dot', () => {
    expect(rule({ hostname: 'HOOKS.Example.COM', address: '100.64.0.7' })).toBe(true);
    expect(rule({ hostname: 'hooks.example.com.', address: '100.64.0.7' })).toBe(true);
  });

  it('never covers an IP literal, even one placed in the list', () => {
    const literalRule = createDenyAddressRule({ privateHosts: new Set(['100.64.0.9', '::ffff:a00:1']) });
    expect(literalRule({ hostname: '100.64.0.9', address: '100.64.0.9' })).toBe(false);
    expect(literalRule({ hostname: '::ffff:a00:1', address: '::ffff:a00:1' })).toBe(false);
  });

  it('allows a public address for any host', () => {
    expect(rule({ hostname: 'other.example.com', address: '93.184.215.14' })).toBe(true);
  });
});

describe('checkWebhookTarget under deny with a listed host', () => {
  it('accepts a listed host that resolves to private network addresses', async () => {
    const resolveHost = resolverOf('100.64.0.7', 'fd00::5');
    const result = await checkWebhookTarget({ url: 'https://hooks.example.com/x', ...DENY_LISTED, resolveHost });
    expect(result).toEqual({ ok: true });
  });

  it('refuses a listed host when one answer is loopback or metadata', async () => {
    for (const restricted of ['127.0.0.1', '169.254.169.254', '::1']) {
      const resolveHost = resolverOf('100.64.0.7', restricted);
      const result = await checkWebhookTarget({ url: 'https://hooks.example.com/x', ...DENY_LISTED, resolveHost });
      expect(result).toEqual({ ok: false, reason: `URL must not point to a private or local address (${restricted})` });
    }
  });

  it('refuses a host that is not listed', async () => {
    const result = await checkWebhookTarget({
      url: 'https://other.example.com/x',
      policy: 'deny',
      privateHosts: PRIVATE_HOSTS,
      resolveHost: resolverOf('100.64.0.7'),
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a private IP literal URL whatever the list holds', async () => {
    const resolveHost = resolverOf('100.64.0.9');
    const result = await checkWebhookTarget({
      url: 'http://100.64.0.9/hook',
      policy: 'deny',
      privateHosts: new Set(['100.64.0.9']),
      resolveHost,
    });
    expect(result.ok).toBe(false);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it('still applies the scheme and credential rules to a listed host', async () => {
    const resolveHost = resolverOf('100.64.0.7');
    const check = (url: string) => checkWebhookTarget({ url, ...DENY_LISTED, resolveHost });
    expect((await check('ftp://hooks.example.com/x')).ok).toBe(false);
    expect((await check('https://a:b@hooks.example.com/x')).ok).toBe(false);
  });
});

describe('createPinnedLookup', () => {
  type LookupResult = { err: NodeJS.ErrnoException | null; address: unknown; family?: number };

  function runLookup(opts: { lookup: ReturnType<typeof createPinnedLookup>; options: object }): Promise<LookupResult> {
    return new Promise((resolve) => {
      opts.lookup('hooks.example.com', opts.options as never, ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) =>
        resolve({ err, address, family })) as never);
    });
  }

  it('hands the socket exactly the checked addresses, resolving once', async () => {
    const resolveHost = resolverOf('93.184.215.14', '2606:4700::1111');
    const lookup = createPinnedLookup({ resolveHost, isAllowedAddress: publicOnly });
    expect(await runLookup({ lookup, options: { all: true } })).toEqual({
      err: null,
      address: [
        { address: '93.184.215.14', family: 4 },
        { address: '2606:4700::1111', family: 6 },
      ],
      family: undefined,
    });
    expect(await runLookup({ lookup, options: { family: 6 } })).toMatchObject({ err: null, address: '2606:4700::1111', family: 6 });
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it('hands a listed host its private address and refuses its loopback answer', async () => {
    const rule = createDenyAddressRule({ privateHosts: PRIVATE_HOSTS });
    const allowed = createPinnedLookup({ resolveHost: resolverOf('100.64.0.7'), isAllowedAddress: rule });
    expect(await runLookup({ lookup: allowed, options: { all: true } })).toEqual({
      err: null,
      address: [{ address: '100.64.0.7', family: 4 }],
      family: undefined,
    });
    const refused = createPinnedLookup({ resolveHost: resolverOf('100.64.0.7', '127.0.0.1'), isAllowedAddress: rule });
    const result = await runLookup({ lookup: refused, options: { all: true } });
    expect(result.err).toBeInstanceOf(WebhookTargetRefusedError);
  });

  it('reports an empty answer as not found, not as a refusal, so the delivery retries it', async () => {
    const lookup = createPinnedLookup({ resolveHost: resolverOf(), isAllowedAddress: publicOnly });
    const result = await runLookup({ lookup, options: { all: true } });
    expect(result.err).not.toBeInstanceOf(WebhookTargetRefusedError);
    expect(result.err?.code).toBe('ENOTFOUND');
  });

  it('fails the connect when any answer is not allowed', async () => {
    const lookup = createPinnedLookup({ resolveHost: resolverOf('93.184.215.14', '127.0.0.1'), isAllowedAddress: publicOnly });
    const result = await runLookup({ lookup, options: { all: true } });
    expect(result.err?.message).toBe('hooks.example.com resolves to a non-public address (127.0.0.1)');
  });
});

describe('createPinnedTransport', () => {
  let server: Server | undefined;
  const received: IncomingMessage[] = [];

  async function listen(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
    server = createServer((req, res) => {
      received.push(req);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    received.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  function post(opts: { url: string; resolveHost: ResolveHost; isAllowedAddress: AddressRule }) {
    const transport = createPinnedTransport({ resolveHost: opts.resolveHost, isAllowedAddress: opts.isAllowedAddress });
    return transport({ url: opts.url, headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', signal: AbortSignal.timeout(5_000) });
  }

  it('connects to the address the resolver returned, not to what system DNS says', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    // .invalid never resolves through system DNS, so a 200 proves the pinned address was used.
    const res = await post({ url: `http://hooks.invalid:${port}/x`, resolveHost: resolverOf('127.0.0.1'), isAllowedAddress: () => true });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.host).toBe(`hooks.invalid:${port}`);
  });

  it('refuses before connecting when the answer is not allowed', async () => {
    await listen((_req, res) => res.end('ok'));
    const port = (server?.address() as AddressInfo).port;
    await expect(
      post({ url: `http://hooks.invalid:${port}/x`, resolveHost: resolverOf('127.0.0.1'), isAllowedAddress: publicOnly }),
    ).rejects.toThrow(/non-public address \(127\.0\.0\.1\)/);
    expect(received).toHaveLength(0);
  });

  it('refuses a non-public IP literal without a lookup', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    const resolveHost = resolverOf('127.0.0.1');
    await expect(post({ url: `http://127.0.0.1:${port}/x`, resolveHost, isAllowedAddress: publicOnly })).rejects.toThrow(
      /non-public address/,
    );
    expect(resolveHost).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it('does not follow a redirect', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/x') {
        res.writeHead(302, { Location: `http://hooks.invalid:${port}/elsewhere` });
        res.end();
        return;
      }
      res.end('followed');
    });
    const res = await post({ url: `http://hooks.invalid:${port}/x`, resolveHost: resolverOf('127.0.0.1'), isAllowedAddress: () => true });
    expect(res.status).toBe(302);
    expect(received.map((req) => req.url)).toEqual(['/x']);
  });

  it('uses one DNS answer per attempt, so a changed answer cannot slip in after the check', async () => {
    const port = await listen((_req, res) => res.end('ok'));
    const answers = ['127.0.0.1', '10.0.0.9'];
    const resolveHost: ResolveHost = vi.fn(async () => [{ address: answers.shift() ?? '10.0.0.9', family: 4 as const }]);
    const isAllowedAddress: AddressRule = ({ address }) => address === '127.0.0.1';
    const first = await post({ url: `http://hooks.invalid:${port}/x`, resolveHost, isAllowedAddress });
    expect(first.status).toBe(200);
    expect(resolveHost).toHaveBeenCalledTimes(1);
    await expect(post({ url: `http://hooks.invalid:${port}/x`, resolveHost, isAllowedAddress })).rejects.toThrow(/10\.0\.0\.9/);
    expect(received).toHaveLength(1);
  });
});
