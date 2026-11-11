import dns from 'node:dns/promises';

/** The sandbox's system resolver is dead, so ask public resolvers directly. */
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

const SES_SPF_INCLUDE = 'include:amazonses.com';
const SES_MX_SUFFIX = 'amazonses.com';
const GOOGLE_WORKSPACE = 'Google Workspace';

interface InboundProvider {
  name: string;
  mxSuffixes: readonly string[];
  spfInclude: string;
}

/**
 * Inbound providers recognised by their MX host. Google Workspace publishes no
 * SPF record of its own, so a Workspace domain often has none; keying the SPF
 * merge on an existing record leaves such a domain with an SES-only SPF.
 */
const INBOUND_PROVIDERS: readonly InboundProvider[] = [
  { name: GOOGLE_WORKSPACE, mxSuffixes: ['google.com', 'googlemail.com'], spfInclude: 'include:_spf.google.com' },
  {
    name: 'Microsoft 365',
    mxSuffixes: ['mail.protection.outlook.com'],
    spfInclude: 'include:spf.protection.outlook.com',
  },
];

export interface MailRouting {
  /** MX hosts that are not SES's feedback host. Empty means the domain is send-only. */
  inboundMx: string[];
  /** The recognised inbound provider, or null for send-only or an unknown provider. */
  provider: InboundProvider | null;
  /** The domain's current `v=spf1` record, if it has one. */
  existingSpf: string | null;
}

export function receivesMailElsewhere(routing: MailRouting): boolean {
  return routing.inboundMx.length > 0 || routing.provider !== null;
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isMissingRecord(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

async function resolveMxHosts(resolver: dns.Resolver, domain: string): Promise<string[]> {
  try {
    const records = await resolver.resolveMx(domain);
    return records.map((record) => record.exchange.replace(/\.$/, '').toLowerCase());
  } catch (err) {
    if (isMissingRecord(err)) return [];
    throw err;
  }
}

async function resolveSpf(resolver: dns.Resolver, domain: string): Promise<string | null> {
  try {
    const records = await resolver.resolveTxt(domain);
    const spf = records.map((chunks) => chunks.join('')).find((value) => value.startsWith('v=spf1'));
    return spf ?? null;
  } catch (err) {
    if (isMissingRecord(err)) return null;
    throw err;
  }
}

/**
 * Looks up where a domain receives mail and what SPF it publishes today.
 * `assumeGoogleWorkspace` covers a domain whose Google MX is not published
 * yet (the old `--receives-mail` meaning).
 */
export async function detectMailRouting(opts: {
  domain: string;
  assumeGoogleWorkspace: boolean;
}): Promise<MailRouting> {
  const resolver = new dns.Resolver();
  resolver.setServers(DNS_SERVERS);

  const [mxHosts, existingSpf] = await Promise.all([
    resolveMxHosts(resolver, opts.domain),
    resolveSpf(resolver, opts.domain),
  ]);

  const inboundMx = mxHosts.filter((host) => !hostMatchesSuffix(host, SES_MX_SUFFIX));
  const detected = INBOUND_PROVIDERS.find((provider) =>
    inboundMx.some((host) => provider.mxSuffixes.some((suffix) => hostMatchesSuffix(host, suffix))),
  );
  const assumed = opts.assumeGoogleWorkspace
    ? INBOUND_PROVIDERS.find((provider) => provider.name === GOOGLE_WORKSPACE)
    : undefined;

  return { inboundMx, provider: detected ?? assumed ?? null, existingSpf };
}

/**
 * The single SPF record the domain should publish: its existing record (or a
 * bare `v=spf1 ~all`) with the provider's include and SES's include added
 * before the `all` term. Includes already present are left where they are.
 */
export function mergedSpfValue(routing: MailRouting): string {
  const terms = (routing.existingSpf ?? 'v=spf1 ~all').split(/\s+/).filter(Boolean);
  const wanted = [routing.provider?.spfInclude, SES_SPF_INCLUDE].filter(
    (include): include is string => include !== undefined,
  );
  const missing = wanted.filter((include) => !terms.includes(include));

  const allIndex = terms.findIndex((term) => /^[~?+-]?all$/.test(term));
  const insertAt = allIndex === -1 ? terms.length : allIndex;
  terms.splice(insertAt, 0, ...missing);
  return terms.join(' ');
}

/** One line that says what the lookup found, printed above the records table. */
export function describeMailRouting(routing: MailRouting): string {
  if (!receivesMailElsewhere(routing)) {
    return 'Mail routing: no inbound MX, send-only. Publish every record, including the SES MX.';
  }
  const mx = routing.inboundMx.length > 0 ? routing.inboundMx.join(', ') : 'none published yet';
  if (routing.provider === null) {
    return (
      `Mail routing: MX ${mx} is an unrecognised provider. Skip the SES MX, and add that ` +
      "provider's SPF include to the merged record by hand."
    );
  }
  return `Mail routing: MX ${mx} (${routing.provider.name}). Skip the SES MX; the SPF row is the merged record.`;
}
