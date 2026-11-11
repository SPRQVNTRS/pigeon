/**
 * The five settings a deployment chooses for itself. Each is read from an
 * environment variable, and the default applies while it is unset or empty.
 * Every default is the neutral or secure value: a deployment that needs the
 * looser one says so explicitly.
 *
 * | Variable                         | Unset means                 |
 * |----------------------------------|-----------------------------|
 * | PIGEON_SERVICE_NAME              | `pigeon`                    |
 * | PIGEON_RATE_LIMIT                | `enforce`                   |
 * | PIGEON_WEBHOOK_PRIVATE_TARGETS   | `deny`                      |
 * | PIGEON_WEBHOOK_PRIVATE_HOSTS     | no host may be private      |
 * | PIGEON_DMARC_RUA                 | no rua address              |
 *
 * Everything else asks for the value through the accessors here. Each accessor
 * reads the environment on every call, so a test or a restart sees the current
 * value. The security settings are explained in docs/security.md.
 */

import { isIP } from 'node:net';

const DEFAULT_SERVICE_NAME = 'pigeon';

/** The service name that tags every log line. */
export function resolveServiceName(): string {
  return process.env['PIGEON_SERVICE_NAME'] || DEFAULT_SERVICE_NAME;
}

/**
 * A bare address such as `dmarc@dmarc.example.com`. No `mailto:` prefix: the
 * DNS record builder adds it. No whitespace, `;`, `,`, `:`, `<`, `>` or `"`,
 * because the value goes into a DMARC TXT record, where `;` starts a new tag
 * and `,` starts a second report address.
 */
const EMAIL_ADDRESS = /^[^\s@;,:<>"]+@[^\s@;,:<>"]+\.[^\s@;,:<>"]+$/;

/**
 * The address DMARC aggregate reports are sent to (the `rua` tag every tenant
 * domain publishes). Returns `undefined` while PIGEON_DMARC_RUA is unset: the
 * proposed DMARC record then has no `rua` tag and the DNS health check does not
 * look for one. Throws on a value that is not an email address.
 */
export function resolveDmarcRua(): string | undefined {
  const raw = process.env['PIGEON_DMARC_RUA']?.trim();
  if (!raw) return undefined;
  if (!EMAIL_ADDRESS.test(raw)) {
    throw new Error(
      `PIGEON_DMARC_RUA must be an email address such as dmarc@dmarc.example.com (no mailto: prefix), got "${raw}"`,
    );
  }
  return raw;
}

export type RateLimitMode = 'enforce' | 'off';

export type WebhookPrivateTargets = 'deny' | 'allow';

function readChoice<T extends string>(opts: { name: string; choices: readonly T[]; fallback: T }): T {
  const raw = process.env[opts.name];
  if (raw === undefined || raw === '') return opts.fallback;
  const value = opts.choices.find((choice) => choice === raw.trim().toLowerCase());
  if (value === undefined) {
    throw new Error(`${opts.name} must be one of ${opts.choices.join(', ')}, got "${raw}"`);
  }
  return value;
}

/**
 * Whether the API key auth path enforces `api_keys.rate_limit_per_second`.
 * `enforce` while unset. Throws on a value that is neither `enforce` nor `off`.
 */
export function resolveRateLimitMode(): RateLimitMode {
  return readChoice({ name: 'PIGEON_RATE_LIMIT', choices: ['enforce', 'off'], fallback: 'enforce' });
}

/**
 * Whether a webhook may target a loopback, private, link-local or other
 * non-public address. `deny` while unset. Throws on a value that is neither
 * `deny` nor `allow`.
 */
export function resolveWebhookPrivateTargets(): WebhookPrivateTargets {
  return readChoice({
    name: 'PIGEON_WEBHOOK_PRIVATE_TARGETS',
    choices: ['deny', 'allow'],
    fallback: 'deny',
  });
}

const PRIVATE_HOSTS_VARIABLE = 'PIGEON_WEBHOOK_PRIVATE_HOSTS';

/** Dot-separated labels of letters, digits and inner hyphens; 63 characters a label, 253 in all. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A last label the URL parser reads as a number, so the whole name becomes an
 * IPv4 address (`2130706433`, `0x7f.1`, `10.1`).
 */
const NUMERIC_LAST_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;

/**
 * The form a host name is compared in: lower case, without the one trailing
 * dot of a fully qualified name. Used for the list entries and for the host of
 * a webhook URL, so `Hooks.Example.com.` matches `hooks.example.com`.
 */
export function normaliseHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/** Why a normalised entry is not an exact host name, or null when it is one. */
function describeBadHostEntry(entry: string): string | null {
  if (entry.includes('://')) return 'a URL with a scheme';
  if (isIP(entry.replace(/^\[|\]$/g, '')) !== 0) return 'an IP address';
  if (entry.includes('*')) return 'a wildcard';
  if (entry.startsWith('.')) return 'a domain suffix';
  if (entry.includes(':')) return 'a host with a port';
  if (entry.includes('/')) return 'a URL with a path';
  if (!HOSTNAME.test(entry)) return 'not a host name';
  if (NUMERIC_LAST_LABEL.test(entry.slice(entry.lastIndexOf('.') + 1))) return 'an IP address';
  return null;
}

/**
 * The host names whose webhook URLs may resolve to a private network address
 * (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) under
 * PIGEON_WEBHOOK_PRIVATE_TARGETS=deny. Comma-separated exact names, compared
 * in `normaliseHostname` form. Empty while unset.
 *
 * Throws on an entry that is not an exact host name: a scheme, a port, a path,
 * a wildcard, a leading-dot suffix or an IP address. A loose entry must not
 * quietly widen the exception.
 */
export function resolveWebhookPrivateHosts(): ReadonlySet<string> {
  const raw = process.env[PRIVATE_HOSTS_VARIABLE] ?? '';
  const hosts = new Set<string>();
  for (const segment of raw.split(',')) {
    const entry = segment.trim();
    if (entry === '') continue;
    const host = normaliseHostname(entry);
    const problem = describeBadHostEntry(host);
    if (problem !== null) {
      throw new Error(
        `${PRIVATE_HOSTS_VARIABLE} must list exact host names such as hooks.example.com, but "${entry}" is ${problem}`,
      );
    }
    hosts.add(host);
  }
  return hosts;
}
