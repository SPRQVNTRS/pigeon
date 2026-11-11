/**
 * DNS Health Verifiers
 *
 * * Each verifier instantiates its own dns.Resolver with per-instance setServers call
 * for test isolation and parallel-safe DNS lookups.
 */

import dns from 'node:dns/promises';
import { resolveDmarcRua } from '#app/config/deployment-settings';
import { getIdentity } from '#app/lib/ses/identity';
import { type DnsCheckResult, type DnsHealthRecordType, DNS_ERROR_LABELS } from './types';

const DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];
const DNS_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(): dns.Resolver {
  const resolver = new dns.Resolver();
  resolver.setServers(DNS_SERVERS);
  return resolver;
}

function withDnsTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        const err = Object.assign(new Error('DNS query timed out'), { code: 'ETIMEOUT' });
        reject(err);
      }, DNS_TIMEOUT_MS),
    ),
  ]);
}

function mapDnsError(code: string | undefined): string {
  return DNS_ERROR_LABELS[code ?? 'UNKNOWN'] ?? `DNS error: ${code ?? 'UNKNOWN'}`;
}

function flattenTxtRecords(records: string[][]): string {
  return records
    .map((chunks) => chunks.join(''))
    .join(' | ')
    .slice(0, 500);
}

/**
 * Inbound mail providers recognised by their MX host. A domain whose MX points
 * at one of them also sends through it, so its single SPF record must carry the
 * provider's include next to SES's. Google Workspace publishes no SPF record by
 * itself, so without this check a Workspace domain passes with SES alone while
 * every mail a person sends from it fails SPF.
 */
const INBOUND_PROVIDERS = [
  { mxSuffixes: ['google.com', 'googlemail.com'], spfInclude: 'include:_spf.google.com' },
  { mxSuffixes: ['mail.protection.outlook.com'], spfInclude: 'include:spf.protection.outlook.com' },
] as const;

const SES_SPF_INCLUDE = 'include:amazonses.com';

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The SPF includes a domain's inbound provider requires. A missing MX
 * (ENODATA, ENOTFOUND) means send-only; any other MX lookup failure also
 * yields none, so a flaky resolver never turns a good SPF record red.
 */
async function resolveProviderSpfIncludes(resolver: dns.Resolver, domainName: string): Promise<string[]> {
  try {
    const mx = await withDnsTimeout(resolver.resolveMx(domainName));
    const hosts = mx.map((record) => record.exchange.replace(/\.$/, '').toLowerCase());
    return INBOUND_PROVIDERS.filter((provider) =>
      hosts.some((host) => provider.mxSuffixes.some((suffix) => hostMatchesSuffix(host, suffix))),
    ).map((provider) => provider.spfInclude);
  } catch {
    return [];
  }
}

function makeResult(
  domainId: string,
  domain: string,
  recordType: DnsHealthRecordType,
  status: DnsCheckResult['status'],
  expected: string,
  actual: string | null,
): DnsCheckResult {
  return { domainId, domain, recordType, status, expected, actual, checkedAt: new Date() };
}

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------

export async function verifyDkimCname(
  domainId: string,
  domainName: string,
  token: string,
  recordType: 'dkim_cname_1' | 'dkim_cname_2' | 'dkim_cname_3',
  region?: string,
): Promise<DnsCheckResult> {
  const _ = region; // unused but kept for consistent API across verifiers
  const host = `${token}._domainkey.${domainName}`;
  const expectedTarget = `${token}.dkim.amazonses.com`;
  const expected = `${host} → ${expectedTarget}`;
  const resolver = makeResolver();

  try {
    const targets = await withDnsTimeout(resolver.resolveCname(host));
    const normalized = targets.map((t) => t.replace(/\.$/, ''));
    const matched = normalized.some((t) => t === expectedTarget);

    return makeResult(
      domainId,
      domainName,
      recordType,
      matched ? 'pass' : 'fail',
      expected,
      normalized.join(', '),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return makeResult(domainId, domainName, recordType, 'error', expected, mapDnsError(code));
  }
}

export async function verifySPF(
  domainId: string,
  domainName: string,
  _region?: string,
): Promise<DnsCheckResult> {
  const resolver = makeResolver();
  const required = [SES_SPF_INCLUDE, ...(await resolveProviderSpfIncludes(resolver, domainName))];
  const expected = required.join(' ');

  try {
    const records = await withDnsTimeout(resolver.resolveTxt(domainName));
    const actual = flattenTxtRecords(records);
    const matched = records.some((chunks) => {
      const record = chunks.join('');
      return required.every((include) => record.includes(include));
    });

    return makeResult(domainId, domainName, 'spf_txt', matched ? 'pass' : 'fail', expected, actual);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return makeResult(domainId, domainName, 'spf_txt', 'error', expected, mapDnsError(code));
  }
}

/**
 * What the DMARC record at `_dmarc.<domain>` must contain. With a configured
 * rua address (PIGEON_DMARC_RUA) the record must carry that address. Without
 * one, any DMARC record passes: the service asks for no report address, so a
 * published rua (ours or the owner's) is neither required nor wrong.
 */
function expectedDmarcText(): string {
  const dmarcRua = resolveDmarcRua();
  if (dmarcRua === undefined) return 'v=DMARC1';
  return `rua=mailto:${dmarcRua}`;
}

export async function verifyDMARC(
  domainId: string,
  domainName: string,
  _region?: string,
): Promise<DnsCheckResult> {
  const expected = expectedDmarcText();
  const host = `_dmarc.${domainName}`;
  const resolver = makeResolver();

  try {
    const records = await withDnsTimeout(resolver.resolveTxt(host));
    const actual = flattenTxtRecords(records);
    const matched = records.some((chunks) => chunks.join('').includes(expected));

    return makeResult(domainId, domainName, 'dmarc_txt', matched ? 'pass' : 'fail', expected, actual);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return makeResult(domainId, domainName, 'dmarc_txt', 'error', expected, mapDnsError(code));
  }
}

export async function verifySESStatus(
  domainId: string,
  domainName: string,
  region?: string,
): Promise<DnsCheckResult> {
  const expected = 'verificationStatus=SUCCESS, dkimStatus=SUCCESS';

  try {
    const info = await getIdentity({ domain: domainName, region });
    const v = info.verifiedForSending ? 'SUCCESS' : 'NOT_VERIFIED';
    const d = info.dkim.status;
    const actual = `verificationStatus=${v}, dkimStatus=${d}`;
    const passed = info.verifiedForSending === true && info.dkim.status === 'SUCCESS';

    return makeResult(domainId, domainName, 'ses_verified', passed ? 'pass' : 'fail', expected, actual);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(domainId, domainName, 'ses_verified', 'error', expected, `SES API error: ${message}`);
  }
}
