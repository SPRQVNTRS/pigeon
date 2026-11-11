/**
 * DMARC XML parser.
 *
 * Parses DMARC aggregate report XML (per RFC 7489) into a typed TS structure.
 * Uses fast-xml-parser for XML parsing.
 *
 * Handles:
 * - Single-record and multi-record reports (record may be object or array)
 * - Missing optional fields (policy_sp, policy_pct, auth_results)
 */

import { XMLParser } from 'fast-xml-parser';

// =============================================================================
// Types
// =============================================================================

export interface DmarcSpfAuthResult {
  domain: string;
  result: string;
}

export interface DmarcDkimAuthResult {
  domain: string;
  selector: string;
  result: string;
}

export interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  dkimEval: string;
  spfEval: string;
  headerFrom: string;
  spfAuthResults: DmarcSpfAuthResult[];
  dkimAuthResults: DmarcDkimAuthResult[];
}

export interface DmarcReport {
  reportId: string;
  orgName: string;
  email?: string;
  /** Unix epoch seconds */
  dateRangeBegin: number;
  /** Unix epoch seconds */
  dateRangeEnd: number;
  policyDomain: string;
  policyAdkim?: string;
  policyAspf?: string;
  policyP?: string;
  policySp?: string;
  policyPct?: number;
  records: DmarcRecord[];
}

// =============================================================================
// Parser
// =============================================================================

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
});

/** Ensure a value is always an array (handles single-item XML elements). */
function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function toString(val: unknown): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

function toNumber(val: unknown): number {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function parseSpfResults(authResults: Record<string, unknown>): DmarcSpfAuthResult[] {
  const spf = authResults['spf'];
  if (!spf) return [];
  return toArray(spf as Record<string, unknown>).map((s) => ({
    domain: toString((s as Record<string, unknown>)['domain']),
    result: toString((s as Record<string, unknown>)['result']),
  }));
}

function parseDkimResults(authResults: Record<string, unknown>): DmarcDkimAuthResult[] {
  const dkim = authResults['dkim'];
  if (!dkim) return [];
  return toArray(dkim as Record<string, unknown>).map((d) => ({
    domain: toString((d as Record<string, unknown>)['domain']),
    selector: toString((d as Record<string, unknown>)['selector']),
    result: toString((d as Record<string, unknown>)['result']),
  }));
}

function parseRecord(rec: Record<string, unknown>): DmarcRecord {
  const row = (rec['row'] ?? {}) as Record<string, unknown>;
  const policyEvaluated = (row['policy_evaluated'] ?? {}) as Record<string, unknown>;
  const identifiers = (rec['identifiers'] ?? {}) as Record<string, unknown>;
  const authResults = (rec['auth_results'] ?? {}) as Record<string, unknown>;

  return {
    sourceIp: toString(row['source_ip']),
    count: toNumber(row['count']),
    disposition: toString(policyEvaluated['disposition']),
    dkimEval: toString(policyEvaluated['dkim']),
    spfEval: toString(policyEvaluated['spf']),
    headerFrom: toString(identifiers['header_from']),
    spfAuthResults: parseSpfResults(authResults),
    dkimAuthResults: parseDkimResults(authResults),
  };
}

/**
 * Parse a DMARC aggregate report XML string.
 *
 * @throws if XML is malformed or missing required fields (report_id, org_name, policy_domain)
 */
export function parseDmarcXml(xml: string): DmarcReport {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const feedback = parsed['feedback'] as Record<string, unknown>;

  if (!feedback) {
    throw new Error('DMARC XML missing <feedback> root element');
  }

  const meta = (feedback['report_metadata'] ?? {}) as Record<string, unknown>;
  const policy = (feedback['policy_published'] ?? {}) as Record<string, unknown>;
  const rawRecords = feedback['record'];

  const reportId = toString(meta['report_id']);
  const orgName = toString(meta['org_name']);
  const policyDomain = toString(policy['domain']);

  if (!reportId) throw new Error('DMARC XML missing <report_id>');
  if (!orgName) throw new Error('DMARC XML missing <org_name>');
  if (!policyDomain) throw new Error('DMARC XML missing <policy_published><domain>');

  const dateRange = (meta['date_range'] ?? {}) as Record<string, unknown>;

  const policyPctRaw = policy['pct'];
  const policyPct =
    policyPctRaw !== undefined && policyPctRaw !== null
      ? toNumber(policyPctRaw)
      : undefined;

  const email = toString(meta['email']) || undefined;
  const policyAdkim = toString(policy['adkim']) || undefined;
  const policyAspf = toString(policy['aspf']) || undefined;
  const policyP = toString(policy['p']) || undefined;
  const policySp = toString(policy['sp']) || undefined;

  const records = toArray<Record<string, unknown>>(rawRecords as Record<string, unknown> | Record<string, unknown>[]).map(parseRecord);

  return {
    reportId,
    orgName,
    email,
    dateRangeBegin: toNumber(dateRange['begin']),
    dateRangeEnd: toNumber(dateRange['end']),
    policyDomain,
    policyAdkim,
    policyAspf,
    policyP,
    policySp,
    policyPct,
    records,
  };
}
