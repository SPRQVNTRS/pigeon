import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  assessFromAuthentication,
  isAligned,
  readSesAuthenticationResults,
  type RawHeaderLine,
} from '../authentication';
import { extractInboundMessage } from '../mime';
import type { InboundVerdicts } from '#drizzle/schema/inbound';
import { receivedMail, sesPrependedHeaders } from '../../../../test/support/inbound-fixtures';

const VICTIM_FROM = 'Kim Customer <kim@example.com>';

/** Parse the raw mail with the real MIME reader, then assess it. */
async function assess(opts: { raw: Buffer; verdicts: InboundVerdicts }) {
  const message = await extractInboundMessage(Readable.from([opts.raw]));
  return assessFromAuthentication({
    fromAddress: message.from,
    hasSingleFrom: message.hasSingleFrom,
    verdicts: opts.verdicts,
    ses: message.sesAuthentication,
  });
}

function sesMail(opts: { results: string[]; from?: string; senderHeaders?: string[] }): Buffer {
  return receivedMail({
    prepended: sesPrependedHeaders({ results: opts.results }),
    senderHeaders: opts.senderHeaders,
    headers: { From: opts.from ?? VICTIM_FROM },
  });
}

const ATTACKER_SES_RESULTS = [
  'spf=pass (spfCheck: domain of example.net designates 192.0.2.8 as permitted sender) client-ip=192.0.2.8; envelope-from=bounce@example.net; helo=mx.example.net',
  'dkim=pass header.i=@example.net header.d=example.net',
  'dmarc=fail header.from=example.com',
];

describe('assessFromAuthentication on raw mail', () => {
  it('spoofed From with a passing DKIM for an unaligned domain is not authenticated', async () => {
    const result = await assess({
      raw: sesMail({ results: ATTACKER_SES_RESULTS }),
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' },
    });
    expect(result.from_authenticated).toBe(false);
    expect(result.authentication).toEqual({
      from_domain: 'example.com',
      dkim_pass_domains: ['example.net'],
      dkim_aligned: false,
      spf_domain: 'example.net',
      spf_aligned: false,
      dmarc_pass: false,
      ses_header_trusted: true,
      single_from: true,
    });
  });

  it('ignores a forged amazonses.com Authentication-Results below the SES one', async () => {
    const forged = 'Authentication-Results: amazonses.com;\r\n spf=pass smtp.mailfrom=kim@example.com;\r\n dkim=pass header.d=example.com;\r\n dmarc=pass header.from=example.com;';
    const result = await assess({
      raw: sesMail({ results: ATTACKER_SES_RESULTS, senderHeaders: [forged] }),
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' },
    });
    expect(result.from_authenticated).toBe(false);
    expect(result.authentication.dkim_pass_domains).toEqual(['example.net']);
    expect(result.authentication.spf_domain).toBe('example.net');
  });

  it('ignores a forged header even between the SES one and X-SES-RECEIPT (first header only)', async () => {
    const [receivedSpf, sesResults, ...rest] = sesPrependedHeaders({ results: ATTACKER_SES_RESULTS });
    const forged = 'Authentication-Results: amazonses.com; dkim=pass header.d=example.com';
    const raw = receivedMail({
      prepended: [receivedSpf!, sesResults!, forged, ...rest],
      headers: { From: VICTIM_FROM },
    });
    const result = await assess({ raw, verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'FAIL' } });
    expect(result.from_authenticated).toBe(false);
    expect(result.authentication.dkim_pass_domains).toEqual(['example.net']);
  });

  it('does not trust an amazonses.com header that sits after X-SES-RECEIPT', async () => {
    // SES wrote no Authentication-Results; the only one is the sender's own.
    const sesBlock = sesPrependedHeaders({ results: [] }).filter((line) => !line.startsWith('Authentication-Results'));
    const forged = 'Authentication-Results: amazonses.com;\r\n spf=pass smtp.mailfrom=kim@example.com;\r\n dkim=pass header.d=example.com;';
    const raw = receivedMail({ prepended: sesBlock, senderHeaders: [forged], headers: { From: VICTIM_FROM } });
    const result = await assess({ raw, verdicts: { spf: 'PASS', dkim: 'PASS' } });
    expect(result.from_authenticated).toBe(false);
    expect(result.authentication).toMatchObject({
      ses_header_trusted: false,
      dkim_pass_domains: [],
      dkim_aligned: false,
      spf_domain: null,
      spf_aligned: false,
    });
  });

  it('receipt dmarc PASS authenticates the From', async () => {
    const result = await assess({
      raw: sesMail({ results: ['spf=fail smtp.mailfrom=bounce@example.net', 'dkim=none', 'dmarc=pass header.from=example.com'] }),
      verdicts: { spf: 'FAIL', dkim: 'GRAY', dmarc: 'PASS' },
    });
    expect(result.from_authenticated).toBe(true);
    expect(result.authentication.dmarc_pass).toBe(true);
  });

  it('aligned DKIM on a subdomain with no DMARC verdict authenticates the From', async () => {
    const raw = sesMail({ results: ['spf=fail smtp.mailfrom=bounce@example.net', 'dkim=pass header.i=@mail.example.com', 'dmarc=none'] });
    for (const verdicts of [
      { spf: 'FAIL', dkim: 'PASS', dmarc: 'GRAY' },
      { spf: 'FAIL', dkim: 'PASS' },
    ]) {
      const result = await assess({ raw, verdicts });
      expect(result.from_authenticated).toBe(true);
      expect(result.authentication.dkim_pass_domains).toEqual(['mail.example.com']);
      expect(result.authentication.dkim_aligned).toBe(true);
    }
  });

  it('aligned SPF alone authenticates the From, but not when the receipt says spf FAIL', async () => {
    const raw = sesMail({
      results: ['spf=pass (spfCheck: designates) client-ip=192.0.2.8; smtp.mailfrom=<bounce@mail.example.com>', 'dkim=none'],
    });
    const passing = await assess({ raw, verdicts: { spf: 'PASS', dkim: 'GRAY' } });
    expect(passing.from_authenticated).toBe(true);
    expect(passing.authentication.spf_domain).toBe('mail.example.com');
    expect(passing.authentication.spf_aligned).toBe(true);

    const receiptFail = await assess({ raw, verdicts: { spf: 'FAIL', dkim: 'GRAY' } });
    expect(receiptFail.from_authenticated).toBe(false);
    expect(receiptFail.authentication.spf_aligned).toBe(false);
  });

  it('all failing is not authenticated', async () => {
    const result = await assess({
      raw: sesMail({ results: ['spf=fail smtp.mailfrom=kim@example.com', 'dkim=fail header.d=example.com', 'dmarc=fail header.from=example.com'] }),
      verdicts: { spf: 'FAIL', dkim: 'FAIL', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' },
    });
    expect(result.from_authenticated).toBe(false);
    expect(result.authentication).toMatchObject({ dkim_pass_domains: [], dkim_aligned: false, spf_aligned: false, dmarc_pass: false });
  });

  it('two From headers are never authenticated, even with dmarc PASS', async () => {
    // mailparser keeps the LAST From; SES may have judged DMARC on the first.
    // No header.from here, so only the single-From rule can catch it.
    const raw = sesMail({
      results: ['dkim=pass header.d=example.net', 'dmarc=pass'],
      senderHeaders: ['From: attacker@example.net'],
    });
    const result = await assess({ raw, verdicts: { dkim: 'PASS', dmarc: 'PASS' } });
    expect(result.authentication.from_domain).toBe('example.com');
    expect(result.authentication.single_from).toBe(false);
    expect(result.from_authenticated).toBe(false);
  });

  it('a From mailbox list is never authenticated', async () => {
    const raw = sesMail({ results: ['dmarc=pass'], from: 'kim@example.com, attacker@example.net' });
    const result = await assess({ raw, verdicts: { dmarc: 'PASS' } });
    expect(result.from_authenticated).toBe(false);
  });

  it('dmarc PASS for another From domain than the one delivered does not count', async () => {
    const raw = sesMail({ results: ['dmarc=pass header.from=example.net'] });
    const result = await assess({ raw, verdicts: { dmarc: 'PASS' } });
    expect(result.authentication.dmarc_pass).toBe(false);
    expect(result.from_authenticated).toBe(false);
  });

  it('a mail with no From address is not authenticated', async () => {
    const raw = sesMail({ results: ['dmarc=pass'], from: '' });
    const result = await assess({ raw, verdicts: { dmarc: 'PASS' } });
    expect(result.authentication.from_domain).toBeNull();
    expect(result.from_authenticated).toBe(false);
  });
});

function lines(...raw: string[]): RawHeaderLine[] {
  return raw.map((line) => ({ key: line.slice(0, line.indexOf(':')).toLowerCase(), line }));
}

describe('readSesAuthenticationResults', () => {
  const RECEIPT = 'X-SES-RECEIPT: AAAA';

  it('reads the real SES header: comments dropped, envelope-from and header.i', () => {
    const facts = readSesAuthenticationResults(
      lines(
        'Received-SPF: pass (spfCheck: domain of eu-central-1.amazonses.com designates 192.0.2.8 as permitted sender) client-ip=192.0.2.8;',
        'Authentication-Results: amazonses.com;\r\n spf=pass (spfCheck: domain of eu-central-1.amazonses.com designates 192.0.2.8 as permitted sender) client-ip=192.0.2.8; envelope-from=0107-000000@eu-central-1.amazonses.com; helo=b224-8.smtp-out.eu-central-1.amazonses.com;\r\n dkim=pass header.i=@example.com;\r\n dkim=pass header.i=@amazonses.com;\r\n dmarc=pass header.from=example.com;',
        RECEIPT,
        'From: probe@example.com',
      ),
    );
    expect(facts).toEqual({
      isTrusted: true,
      dkimPassDomains: ['example.com', 'amazonses.com'],
      spfResult: 'pass',
      spfDomain: 'eu-central-1.amazonses.com',
      dmarcResult: 'pass',
      dmarcFromDomain: 'example.com',
    });
  });

  it('prefers header.d over header.i and smtp.mailfrom over envelope-from; skips non-pass dkim', () => {
    const facts = readSesAuthenticationResults(
      lines(
        'Authentication-Results: AmazonSES.com ; spf=PASS envelope-from=a@other.example.org smtp.mailfrom="b@Mail.Example.COM."; dkim=pass header.i=@x.example.org header.d=Example.ORG; dkim=fail header.d=example.net; dkim=pass header.d=example.org',
        RECEIPT,
      ),
    );
    expect(facts.dkimPassDomains).toEqual(['example.org']);
    expect(facts.spfResult).toBe('pass');
    expect(facts.spfDomain).toBe('mail.example.com');
  });

  it('does not split on a semicolon inside a comment or a quoted string', () => {
    const facts = readSesAuthenticationResults(
      lines(
        'Authentication-Results: amazonses.com (note; with (nested) semicolon); spf=pass (why; this) reason="x; y" smtp.mailfrom=bounce@example.com; dkim=pass header.d=example.com',
        RECEIPT,
      ),
    );
    expect(facts.isTrusted).toBe(true);
    expect(facts.spfDomain).toBe('example.com');
    expect(facts.dkimPassDomains).toEqual(['example.com']);
  });

  it('has no trusted facts for another authserv-id, a missing receipt header, or a header after it', () => {
    const header = 'Authentication-Results: amazonses.com; dkim=pass header.d=example.com';
    expect(readSesAuthenticationResults(lines('Authentication-Results: mx.example.org; dkim=pass header.d=example.com', RECEIPT)).isTrusted).toBe(false);
    expect(readSesAuthenticationResults(lines('Authentication-Results: amazonses.com.evil; dkim=pass header.d=example.com', RECEIPT)).isTrusted).toBe(false);
    expect(readSesAuthenticationResults(lines(header))).toMatchObject({ isTrusted: false, dkimPassDomains: [] });
    expect(readSesAuthenticationResults(lines(RECEIPT, header))).toMatchObject({ isTrusted: false, dkimPassDomains: [] });
  });

  it('takes only the first Authentication-Results header, even if it is not from SES', () => {
    const facts = readSesAuthenticationResults(
      lines('Authentication-Results: mx.example.org; dkim=pass header.d=example.com', 'Authentication-Results: amazonses.com; dkim=pass header.d=example.com', RECEIPT),
    );
    expect(facts.isTrusted).toBe(false);
    expect(facts.dkimPassDomains).toEqual([]);
  });
});

describe('isAligned', () => {
  it.each([
    ['example.com', 'example.com', true],
    ['mail.example.com', 'example.com', true],
    ['example.com', 'a.b.example.com', true],
    ['EXAMPLE.com.', 'example.COM', true],
    ['badexample.com', 'example.com', false],
    ['example.com', 'badexample.com', false],
    ['example.com.evil.example.net', 'example.com', false],
    ['a.example.com', 'b.example.com', false],
    ['example.net', 'example.com', false],
    ['com', 'example.com', false],
    ['', 'example.com', false],
    ['example.com', '', false],
    ['exa mple.com', 'example.com', false],
  ])('%s vs %s is %s', (a, b, expected) => {
    expect(isAligned(a, b)).toBe(expected);
  });

  it('is false when either side is null', () => {
    expect(isAligned(null, 'example.com')).toBe(false);
    expect(isAligned('example.com', null)).toBe(false);
  });
});
