/**
 * DNS record builder — pure function, no side effects.
 *
 * Produces all required DNS records for a domain to send via SES with
 * EasyDKIM, SPF, DMARC and MX feedback routing.
 */

import { resolveDmarcRua } from '#app/config/deployment-settings';
import { buildDmarcRecordValue } from './dmarc-record';

export type DnsRecordType = 'CNAME' | 'TXT' | 'MX';

export interface DnsRecord {
  type: DnsRecordType;
  host: string;
  value: string;
  ttl: number;
  priority?: number;
  notes?: string;
}

export interface BuildDnsRecordsOptions {
  domain: string;
  region: string;
  dkimTokens: string[];
  /** Override the DMARC rua address. Falls back to the configured rua
   *  (PIGEON_DMARC_RUA, see app/config/deployment-settings.ts). With neither,
   *  the DMARC record has no rua tag. */
  dmarcRua?: string;
}

/**
 * Build the full set of DNS records required for a domain to send via SES.
 *
 * Returns:
 * - 3× CNAME for EasyDKIM
 * - 1× TXT for SPF
 * - 1× TXT for DMARC (rua from dmarcRua param or PIGEON_DMARC_RUA env, none when both are unset)
 * - 1× MX for SES feedback routing
 */
export function buildDnsRecords({
  domain,
  region,
  dkimTokens,
  dmarcRua,
}: BuildDnsRecordsOptions): DnsRecord[] {
  const rua = dmarcRua ?? resolveDmarcRua();
  const dkimRecords = buildDkimRecords({ domain, dkimTokens });
  const spfRecord = buildSpfRecord(domain);
  const dmarcRecord = buildDmarcRecord(domain, rua);
  const mxRecord = buildMxRecord({ domain, region });

  return [...dkimRecords, spfRecord, dmarcRecord, mxRecord];
}

// ---------------------------------------------------------------------------
// Private builders
// ---------------------------------------------------------------------------

function buildDkimRecords({
  domain,
  dkimTokens,
}: {
  domain: string;
  dkimTokens: string[];
}): DnsRecord[] {
  return dkimTokens.map((token) => ({
    type: 'CNAME' as const,
    host: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    ttl: 3600,
    notes: 'DNS-only: do not proxy (e.g. Cloudflare grey cloud); proxying breaks SES verification',
  }));
}

function buildSpfRecord(domain: string): DnsRecord {
  return {
    type: 'TXT',
    host: domain,
    value: '"v=spf1 include:amazonses.com ~all"',
    ttl: 3600,
    notes:
      'Only one v=spf1 TXT is allowed. If the domain receives mail elsewhere (its MX is not amazonses.com) or already has SPF, publish one merged record that keeps that provider\'s include. Google Workspace publishes no SPF of its own, so add it even when none exists: "v=spf1 include:_spf.google.com include:amazonses.com ~all"',
  };
}

function buildDmarcRecord(domain: string, rua: string | undefined): DnsRecord {
  return {
    type: 'TXT',
    host: `_dmarc.${domain}`,
    value: buildDmarcRecordValue(rua),
    ttl: 3600,
    notes: 'Start at p=none; escalate to quarantine/reject after monitoring reports',
  };
}

function buildMxRecord({
  domain,
  region,
}: {
  domain: string;
  region: string;
}): DnsRecord {
  return {
    type: 'MX',
    host: domain,
    value: `feedback-smtp.${region}.amazonses.com`,
    ttl: 3600,
    priority: 10,
    notes:
      'Skip if the domain already receives mail (an existing MX, e.g. Google Workspace, must win). Only for send-only domains. SES sending verifies without it',
  };
}
