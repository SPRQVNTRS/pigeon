/**
 * DNS Health Monitoring Types
 *
 * Separate from `DnsRecordType` in ses/dns.ts which describes DNS record
 * format types (CNAME/TXT/MX). This type describes what we're verifying.
 */

export type DnsHealthRecordType =
  | 'dkim_cname_1'
  | 'dkim_cname_2'
  | 'dkim_cname_3'
  | 'spf_txt'
  | 'dmarc_txt'
  | 'ses_verified';

export type DnsCheckStatus = 'pass' | 'fail' | 'error';

export interface DnsCheckResult {
  domainId: string;
  domain: string;
  recordType: DnsHealthRecordType;
  status: DnsCheckStatus;
  /** For DKIM: "{host} → {target}" format. For TXT: what we expected to find. */
  expected: string;
  /** For TXT: ALL discovered values joined, truncated to 500 chars. For error: human-readable error label. */
  actual: string | null;
  checkedAt: Date;
}

export const DNS_ERROR_LABELS: Record<string, string> = {
  ENOTFOUND: 'Host not found (NXDOMAIN)',
  ENODATA: 'No records of this type',
  ESERVFAIL: 'DNS server failure',
  ETIMEOUT: 'DNS query timed out',
  ECONNREFUSED: 'DNS server refused connection',
};
