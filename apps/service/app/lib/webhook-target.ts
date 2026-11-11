/**
 * Where a webhook may point: the server-side request forgery (SSRF) guard.
 *
 * A tenant picks the webhook URL, and the worker POSTs to it from inside our
 * network. Without a guard a URL could reach the cloud metadata address, a
 * database port or an admin panel on a private network. Two rule sets:
 *
 * - Always (both settings): the scheme is http or https, and the URL holds no
 *   user name or password.
 * - PIGEON_WEBHOOK_PRIVATE_TARGETS=deny (the default): every address the host resolves to
 *   must pass `createDenyAddressRule`. One refused answer refuses the whole
 *   host, because the connect could pick any of them. An IP literal is checked
 *   the same way. `new URL` already folds decimal, octal and hex IPv4 forms
 *   (2130706433, 0177.0.0.1, 0x7f.1) into dotted form, so the literal check
 *   sees 127.0.0.1.
 *
 * The deny rule sorts an address into one of three classes (`classifyAddress`).
 * Public is allowed. Restricted (loopback, link-local, metadata, unspecified,
 * multicast, reserved) is refused. Private network (10/8, 172.16/12,
 * 192.168/16, 100.64/10, fc00::/7) is refused, except for a host name listed
 * in PIGEON_WEBHOOK_PRIVATE_HOSTS. An IP literal is never covered by that list.
 *
 * The check at registration is advice to the admin. The check that protects is
 * the one at delivery: `createPinnedLookup` resolves the host, checks every
 * answer and hands exactly those addresses to the socket, so a DNS answer
 * cannot change between the check and the connect (DNS rebinding). Both use
 * the same `createDenyAddressRule`.
 *
 * Only Node built-ins: node:dns for resolution, node:net for the address
 * ranges (BlockList also matches IPv4-mapped IPv6 forms against IPv4 rules).
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import {
  normaliseHostname,
  resolveWebhookPrivateHosts,
  resolveWebhookPrivateTargets,
  type WebhookPrivateTargets,
} from '#app/config/deployment-settings';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolve a host name to every address a connect could use. */
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type WebhookTargetCheck = { ok: true } | { ok: false; reason: string };

/** The system resolver, as a socket connect would use it (honours /etc/hosts). */
export const resolveHostWithSystemDns: ResolveHost = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

type AddressRange = { network: string; prefix: number; type: 'ipv4' | 'ipv6' };

/**
 * Private network ranges. Refused under `deny`, except for a host named in
 * PIGEON_WEBHOOK_PRIVATE_HOSTS (split DNS: a public name that resolves to an
 * internal address from inside the container).
 */
const PRIVATE_NETWORK_RANGES: readonly AddressRange[] = [
  { network: '10.0.0.0', prefix: 8, type: 'ipv4' }, // private
  { network: '100.64.0.0', prefix: 10, type: 'ipv4' }, // carrier-grade NAT, tailnets
  { network: '172.16.0.0', prefix: 12, type: 'ipv4' }, // private
  { network: '192.168.0.0', prefix: 16, type: 'ipv4' }, // private
  { network: 'fc00::', prefix: 7, type: 'ipv6' }, // unique local
];

/** Ranges refused under `deny` for every host, listed or not. */
const RESTRICTED_RANGES: readonly AddressRange[] = [
  { network: '0.0.0.0', prefix: 8, type: 'ipv4' }, // unspecified, "this network"
  { network: '127.0.0.0', prefix: 8, type: 'ipv4' }, // loopback
  { network: '169.254.0.0', prefix: 16, type: 'ipv4' }, // link-local, cloud metadata
  { network: '224.0.0.0', prefix: 4, type: 'ipv4' }, // multicast
  { network: '240.0.0.0', prefix: 4, type: 'ipv4' }, // reserved, broadcast
  { network: '::', prefix: 96, type: 'ipv6' }, // unspecified, loopback, IPv4-compatible
  { network: '64:ff9b::', prefix: 96, type: 'ipv6' }, // NAT64, embeds an IPv4 address
  { network: 'fe80::', prefix: 10, type: 'ipv6' }, // link-local
  { network: 'fec0::', prefix: 10, type: 'ipv6' }, // site-local (deprecated)
  { network: 'ff00::', prefix: 8, type: 'ipv6' }, // multicast
];

function blockListOf(ranges: readonly AddressRange[]): BlockList {
  const list = new BlockList();
  for (const range of ranges) list.addSubnet(range.network, range.prefix, range.type);
  return list;
}

const privateNetwork = blockListOf(PRIVATE_NETWORK_RANGES);
const restricted = blockListOf(RESTRICTED_RANGES);

/**
 * - `public`: outside every range below.
 * - `private`: a private network range (10/8, 172.16/12, 192.168/16,
 *   100.64/10, fc00::/7).
 * - `restricted`: loopback, link-local (the cloud metadata address too),
 *   unspecified, multicast, reserved, NAT64 or site-local. Also anything that
 *   is not an IP address.
 *
 * BlockList matches the IPv4-mapped IPv6 form (::ffff:a.b.c.d) against the
 * IPv4 rules, so that form lands in the class of its IPv4 address.
 */
export type AddressClass = 'public' | 'private' | 'restricted';

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return 'restricted';
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (restricted.check(address, type)) return 'restricted';
  if (privateNetwork.check(address, type)) return 'private';
  return 'public';
}

/**
 * True for an IP address outside every loopback, private, link-local, CGNAT,
 * unique-local, unspecified, multicast and reserved range, including the
 * IPv4-mapped IPv6 form of those. False for anything that is not an IP.
 */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

/** Whether `address` may be used to reach `hostname`. */
export type AddressRule = (target: { hostname: string; address: string }) => boolean;

/**
 * The address rule under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny. A public
 * address is always allowed. A private network address is allowed only for a
 * host name in `privateHosts`. A restricted address is never allowed. An IP
 * literal is never covered by the list, whatever it holds.
 */
export function createDenyAddressRule(opts: { privateHosts: ReadonlySet<string> }): AddressRule {
  return ({ hostname, address }) => {
    const addressClass = classifyAddress(address);
    if (addressClass === 'public') return true;
    if (addressClass === 'restricted') return false;
    if (isIP(hostname) !== 0) return false;
    return opts.privateHosts.has(normaliseHostname(hostname));
  };
}

/** The host of a URL without the IPv6 brackets. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/** Scheme and credential rules. They apply under both settings. */
export function checkWebhookUrlShape(raw: string): WebhookTargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Must be a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Must be an http or https URL' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URL must not contain a username or password' };
  }
  return { ok: true };
}

/** Refuses when any address fails the rule. Names the first offender for the admin. */
function checkAddresses(opts: {
  hostname: string;
  addresses: readonly ResolvedAddress[];
  isAllowedAddress: AddressRule;
}): WebhookTargetCheck {
  const { hostname, addresses, isAllowedAddress } = opts;
  if (addresses.length === 0) return { ok: false, reason: `${hostname} does not resolve to any address` };
  const blocked = addresses.find((entry) => !isAllowedAddress({ hostname, address: entry.address }));
  if (blocked) {
    return { ok: false, reason: `URL must not point to a private or local address (${blocked.address})` };
  }
  return { ok: true };
}

/**
 * The full check of a webhook URL under the given setting. Resolves the host
 * only under `deny`, where `privateHosts` (PIGEON_WEBHOOK_PRIVATE_HOSTS) may
 * let a listed host resolve to a private network address. Never throws: a
 * resolver failure refuses the URL.
 */
export async function checkWebhookTarget(opts: {
  url: string;
  policy: WebhookPrivateTargets;
  privateHosts: ReadonlySet<string>;
  resolveHost: ResolveHost;
}): Promise<WebhookTargetCheck> {
  const shape = checkWebhookUrlShape(opts.url);
  if (!shape.ok || opts.policy === 'allow') return shape;

  const isAllowedAddress = createDenyAddressRule({ privateHosts: opts.privateHosts });
  const hostname = bareHostname(new URL(opts.url));
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const literal: ResolvedAddress = { address: hostname, family: literalFamily === 6 ? 6 : 4 };
    return checkAddresses({ hostname, addresses: [literal], isAllowedAddress });
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await opts.resolveHost(hostname);
  } catch {
    return { ok: false, reason: `${hostname} could not be resolved` };
  }
  return checkAddresses({ hostname, addresses, isAllowedAddress });
}

/**
 * The target rules refuse this URL or host. Thrown by the pinned transport (an
 * IP literal) and into the socket by the pinned lookup (a resolved address).
 * The answer does not change on a retry, so the delivery stops at the first
 * attempt and records the message.
 */
export class WebhookTargetRefusedError extends Error {
  readonly code = 'EWEBHOOKTARGET';

  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetRefusedError';
  }
}

function familyFilter(options: unknown): 4 | 6 | null {
  const family = typeof options === 'number' ? options : (options as { family?: unknown } | null)?.family;
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return null;
}

function wantsAll(options: unknown): boolean {
  return typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
}

/**
 * A resolution that found no usable address. Not a refusal: DNS can answer
 * differently on the next attempt, so the delivery retries it like ENOTFOUND.
 */
function noAddressError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'ENOTFOUND' });
}

/**
 * A `lookup` for http.request / net.connect that resolves once, refuses the
 * host when any answer fails `isAllowedAddress`, and gives the socket exactly
 * the addresses it checked. The check and the connect use one DNS answer.
 */
export function createPinnedLookup(opts: { resolveHost: ResolveHost; isAllowedAddress: AddressRule }): LookupFunction {
  return (hostname, options, callback) => {
    const done = callback as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
    opts.resolveHost(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          done(noAddressError(`${hostname} does not resolve to any address`), '');
          return;
        }
        const blocked = answers.find((entry) => !opts.isAllowedAddress({ hostname, address: entry.address }));
        if (blocked) {
          done(new WebhookTargetRefusedError(`${hostname} resolves to a non-public address (${blocked.address})`), '');
          return;
        }
        const family = familyFilter(options);
        const usable = family === null ? answers : answers.filter((entry) => entry.family === family);
        const first = usable[0];
        if (!first) {
          done(noAddressError(`${hostname} has no IPv${family} address`), '');
          return;
        }
        if (wantsAll(options)) {
          done(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
          return;
        }
        done(null, first.address, first.family);
      },
      (err: unknown) => done(err instanceof Error ? err : new Error(String(err)), ''),
    );
  };
}

/**
 * The registration and update check: the live settings and the system
 * resolver. It tells the admin early; delivery checks again on every attempt.
 */
export function checkRegistrableWebhookUrl(url: string): Promise<WebhookTargetCheck> {
  return checkWebhookTarget({
    url,
    policy: resolveWebhookPrivateTargets(),
    privateHosts: resolveWebhookPrivateHosts(),
    resolveHost: resolveHostWithSystemDns,
  });
}
