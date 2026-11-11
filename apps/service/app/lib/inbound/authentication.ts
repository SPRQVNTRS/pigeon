/**
 * Sender authentication for `email.received`: is the From address of a
 * received mail authenticated? Pure: no I/O, no logging.
 *
 * Two sources, with different trust:
 *
 * - The SES receipt verdicts (`spfVerdict`, `dkimVerdict`, `dmarcVerdict`)
 *   come in the SNS message, whose signature the route checks. They are
 *   trusted, but say nothing about WHICH domain passed.
 * - The `Authentication-Results` header SES prepends to the raw mail names the
 *   domains. A sender can write any header into their own mail, so only the
 *   header SES wrote counts (see `readSesAuthenticationResults`). The header
 *   only ever supplies domains; each branch is gated by a receipt verdict.
 *
 * Privacy: the facts hold domains only, never an address. Callers must not
 * log the domains either.
 */

import type { InboundVerdicts } from '#drizzle/schema/inbound';
import { normaliseInboundDomainName } from './domain-name';

/** One raw header line as mailparser's `headerLines` event emits it, in message order. */
export interface RawHeaderLine {
  /** Lower-case header name. */
  key: string;
  /** The whole header, name included, folding kept. */
  line: string;
}

/** What the trusted SES `Authentication-Results` header says. Domains are lower case. */
export interface SesAuthenticationFacts {
  /** False when no header passed the trust rule; every other field is then empty. */
  isTrusted: boolean;
  /** Signing domain of each `dkim=pass` result, in header order, no duplicates. */
  dkimPassDomains: string[];
  /** Result word of the first `spf=` result, lower case (`pass`, `fail`, ...). */
  spfResult: string | null;
  /** Domain of the envelope sender (`smtp.mailfrom` or `envelope-from`) of that result. */
  spfDomain: string | null;
  /** Result word of the first `dmarc=` result. Information only. */
  dmarcResult: string | null;
  /** The From domain SES evaluated DMARC for (`header.from`). */
  dmarcFromDomain: string | null;
}

/** The `authentication` object of `email.received`. Key order is part of the signed body. */
export interface FromAuthentication {
  from_domain: string | null;
  dkim_pass_domains: string[];
  dkim_aligned: boolean;
  spf_domain: string | null;
  spf_aligned: boolean;
  dmarc_pass: boolean;
  ses_header_trusted: boolean;
  single_from: boolean;
}

export interface FromAuthenticationAssessment {
  from_authenticated: boolean;
  authentication: FromAuthentication;
}

const SES_AUTHSERV_ID = 'amazonses.com';
const AUTHENTICATION_RESULTS = 'authentication-results';
const SES_RECEIPT = 'x-ses-receipt';
const PASS_VERDICT = 'PASS';
const PASS_RESULT = 'pass';

function untrustedFacts(): SesAuthenticationFacts {
  return {
    isTrusted: false,
    dkimPassDomains: [],
    spfResult: null,
    spfDomain: null,
    dmarcResult: null,
    dmarcFromDomain: null,
  };
}

/** The header body after the name, unfolded to one line. */
function headerBody(line: string): string {
  const colon = line.indexOf(':');
  if (colon === -1) return '';
  return line.slice(colon + 1).replace(/\r?\n/g, ' ');
}

/**
 * Drop RFC 5322 comments (nested parentheses, quoted pairs). A comment becomes
 * one space. Quoted strings are kept whole, so a parenthesis inside quotes is
 * not a comment. An unclosed comment swallows the rest, which can only lose
 * facts, never add them.
 */
function stripComments(value: string): string {
  let output = '';
  let depth = 0;
  let isQuoted = false;
  let index = 0;
  while (index < value.length) {
    const char = value.charAt(index);
    index += 1;
    if (char === '\\') {
      if (depth === 0) output += char + value.charAt(index);
      index += 1;
      continue;
    }
    if (isQuoted) {
      output += char;
      if (char === '"') isQuoted = false;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0) output += ' ';
      continue;
    }
    if (depth > 0) continue;
    if (char === '"') isQuoted = true;
    output += char;
  }
  return output;
}

/** Split on separator characters that are not inside a quoted string. */
function splitOutsideQuotes(opts: { text: string; isSeparator: (char: string) => boolean }): string[] {
  const parts: string[] = [];
  let current = '';
  let isQuoted = false;
  let index = 0;
  while (index < opts.text.length) {
    const char = opts.text.charAt(index);
    index += 1;
    if (char === '\\' && isQuoted) {
      current += char + opts.text.charAt(index);
      index += 1;
      continue;
    }
    if (char === '"') isQuoted = !isQuoted;
    if (!isQuoted && opts.isSeparator(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** `"a\"b"` gives `a"b`; `<addr>` gives `addr`. */
function unquoteValue(raw: string): string {
  const trimmed = raw.trim();
  const isQuotedString = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  const unquoted = isQuotedString ? trimmed.slice(1, -1).replace(/\\(.)/g, '$1').trim() : trimmed;
  const isAngled = unquoted.startsWith('<') && unquoted.endsWith('>');
  return isAngled ? unquoted.slice(1, -1).trim() : unquoted;
}

interface ResultInfo {
  method: string;
  result: string;
  properties: Map<string, string>;
}

/**
 * Authentication methods from the IANA registry. A clause that starts with
 * one opens a new result. SES writes the SPF properties as clauses of their
 * own (`spf=pass ... client-ip=...; envelope-from=...; helo=...;`), so any
 * other clause adds its pairs to the result before it.
 */
const METHODS = new Set([
  'arc', 'auth', 'bimi', 'dkim', 'dkim-adsp', 'dkim-atps', 'dmarc', 'dnswl', 'domainkeys',
  'iprev', 'rrvs', 'sender-id', 'smime', 'spf', 'vbr',
]);

/** `key=value` pairs of one clause, separated by whitespace outside quotes. */
function clausePairs(clause: string): Array<{ key: string; value: string }> {
  return splitOutsideQuotes({
    text: clause.replace(/\s*=\s*/g, '='),
    isSeparator: (char) => /\s/.test(char),
  })
    .map((token) => ({ token, equals: token.indexOf('=') }))
    .filter(({ equals }) => equals > 0)
    .map(({ token, equals }) => ({ key: token.slice(0, equals).toLowerCase(), value: unquoteValue(token.slice(equals + 1)) }));
}

/** Method name without a `/version` suffix. */
function methodOf(key: string): string {
  return key.split('/')[0] ?? '';
}

function addProperties(info: ResultInfo, pairs: ReadonlyArray<{ key: string; value: string }>): void {
  for (const { key, value } of pairs) {
    if (!info.properties.has(key)) info.properties.set(key, value);
  }
}

/** Group the clauses after the authserv-id into results. Pairs before any method are dropped. */
function parseResults(clauses: readonly string[]): ResultInfo[] {
  const results: ResultInfo[] = [];
  for (const clause of clauses) {
    const [head, ...rest] = clausePairs(clause);
    if (head === undefined) continue;
    const current = results[results.length - 1];
    if (METHODS.has(methodOf(head.key))) {
      const info: ResultInfo = { method: methodOf(head.key), result: head.value.toLowerCase(), properties: new Map() };
      addProperties(info, rest);
      results.push(info);
      continue;
    }
    if (current !== undefined) addProperties(current, [head, ...rest]);
  }
  return results;
}

function normaliseDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  return domain === '' ? null : domain;
}

/** Domain after the last `@`. Null without an `@`. */
function domainAfterAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const at = value.lastIndexOf('@');
  if (at === -1) return null;
  return normaliseDomain(value.slice(at + 1));
}

/** `header.d`, else the domain of `header.i`. */
function dkimDomain(info: ResultInfo): string | null {
  const signingDomain = info.properties.get('header.d');
  if (signingDomain !== undefined) return normaliseDomain(signingDomain);
  return domainAfterAt(info.properties.get('header.i'));
}

/** RFC 8601 allows `smtp.mailfrom` to be a bare domain, so a value with no `@` is the domain. */
function envelopeDomain(info: ResultInfo): string | null {
  const sender = info.properties.get('smtp.mailfrom') ?? info.properties.get('envelope-from');
  if (sender === undefined) return null;
  if (!sender.includes('@')) return normaliseDomain(sender);
  return domainAfterAt(sender);
}

/**
 * The first `Authentication-Results` header, when SES wrote it.
 *
 * Trust rule: only the FIRST `Authentication-Results` header of the mail
 * counts, and only when its authserv-id (text before the first `;`) is
 * exactly `amazonses.com` and it comes before the first `X-SES-RECEIPT`
 * header. SES prepends both above everything the sender wrote, so a header a
 * sender forged (even one with authserv-id `amazonses.com`) sits lower and is
 * ignored. A mail with no `X-SES-RECEIPT` did not pass through SES receiving
 * as we expect, so it has no trusted facts either.
 */
function findSesHeader(headerLines: readonly RawHeaderLine[]): string | null {
  const resultsIndex = headerLines.findIndex((header) => header.key.toLowerCase() === AUTHENTICATION_RESULTS);
  const receiptIndex = headerLines.findIndex((header) => header.key.toLowerCase() === SES_RECEIPT);
  if (resultsIndex === -1 || receiptIndex === -1) return null;
  if (resultsIndex > receiptIndex) return null;
  return headerLines[resultsIndex]?.line ?? null;
}

/** Read the trusted SES `Authentication-Results` header from the ordered raw header lines. */
export function readSesAuthenticationResults(headerLines: readonly RawHeaderLine[]): SesAuthenticationFacts {
  const line = findSesHeader(headerLines);
  if (line === null) return untrustedFacts();

  const [authservId = '', ...clauses] = splitOutsideQuotes({
    text: stripComments(headerBody(line)),
    isSeparator: (char) => char === ';',
  });
  if (authservId.trim().toLowerCase() !== SES_AUTHSERV_ID) return untrustedFacts();

  const results = parseResults(clauses);
  const dkimPassDomains = results
    .filter((info) => info.method === 'dkim' && info.result === PASS_RESULT)
    .map(dkimDomain)
    .filter((domain): domain is string => domain !== null);
  const spf = results.find((info) => info.method === 'spf');
  const dmarc = results.find((info) => info.method === 'dmarc');
  const dmarcFrom = dmarc?.properties.get('header.from');

  return {
    isTrusted: true,
    dkimPassDomains: [...new Set(dkimPassDomains)],
    spfResult: spf?.result ?? null,
    spfDomain: spf ? envelopeDomain(spf) : null,
    dmarcResult: dmarc?.result ?? null,
    dmarcFromDomain: dmarcFrom === undefined ? null : normaliseDomain(dmarcFrom),
  };
}

/**
 * Relaxed domain alignment WITHOUT a public suffix list: true when both are
 * the same valid domain, or one is a subdomain of the other on a label
 * boundary (`mail.example.com` and `example.com`). `badexample.com` and
 * `example.com` never align. Empty or invalid domains, and single labels such
 * as `com`, never align.
 *
 * Limitation (no PSL): DMARC relaxed alignment compares organizational
 * domains. This approximation is stricter for siblings
 * (`a.example.com` and `b.example.com` do not align here), and looser in one
 * case: when the From domain is itself a public suffix that hands out
 * subdomains to strangers (for example a shared hosting suffix), a stranger's
 * subdomain aligns with it.
 */
export function isAligned(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = normaliseInboundDomainName(a);
  const right = normaliseInboundDomainName(b);
  if (!left.ok || !right.ok) return false;
  if (left.name === right.name) return true;
  return left.name.endsWith(`.${right.name}`) || right.name.endsWith(`.${left.name}`);
}

/** Domain after the last `@` of a bare address, lower case and valid; else null. */
function fromDomainOf(fromAddress: string): string | null {
  const domain = domainAfterAt(fromAddress);
  if (domain === null) return null;
  const normalised = normaliseInboundDomainName(domain);
  return normalised.ok ? normalised.name : null;
}

/**
 * Is the From address authenticated?
 *
 *   from_authenticated = single From mailbox AND a From domain AND (
 *        receipt dmarc PASS (and the SES header does not name another From domain)
 *     OR receipt dkim PASS AND a dkim=pass domain in the SES header aligned with the From domain
 *     OR receipt spf PASS AND spf=pass in the SES header AND its envelope domain aligned)
 *
 * The single-From rule: with two From headers mailparser takes the last one
 * while SES may judge DMARC on another, and a mailbox list has the same gap.
 * Such a mail is never authenticated.
 */
export function assessFromAuthentication(opts: {
  fromAddress: string;
  hasSingleFrom: boolean;
  verdicts: InboundVerdicts;
  ses: SesAuthenticationFacts;
}): FromAuthenticationAssessment {
  const { verdicts, ses } = opts;
  const fromDomain = fromDomainOf(opts.fromAddress);
  const isDkimAligned =
    verdicts.dkim === PASS_VERDICT && ses.dkimPassDomains.some((domain) => isAligned(domain, fromDomain));
  const isSpfAligned =
    verdicts.spf === PASS_VERDICT && ses.spfResult === PASS_RESULT && isAligned(ses.spfDomain, fromDomain);
  const isDmarcContradicted =
    ses.dmarcFromDomain !== null && fromDomain !== null && ses.dmarcFromDomain !== fromDomain;
  const isDmarcPass = verdicts.dmarc === PASS_VERDICT && !isDmarcContradicted;
  const hasAnyPass = isDmarcPass || isDkimAligned || isSpfAligned;

  return {
    from_authenticated: opts.hasSingleFrom && fromDomain !== null && hasAnyPass,
    authentication: {
      from_domain: fromDomain,
      dkim_pass_domains: [...ses.dkimPassDomains],
      dkim_aligned: isDkimAligned,
      spf_domain: ses.spfDomain,
      spf_aligned: isSpfAligned,
      dmarc_pass: isDmarcPass,
      ses_header_trusted: ses.isTrusted,
      single_from: opts.hasSingleFrom,
    },
  };
}
