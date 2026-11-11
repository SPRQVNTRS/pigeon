/**
 * DMARC ingestion pipeline tests: the XML parser, attachment decompression
 * with its size caps, and POST /v1/webhooks/dmarc request handling with real
 * SNS signature verification (a test RSA key stands in for the AWS cert) and
 * in-memory stand-ins for S3 and the database.
 *
 * The happy path against a real Postgres is test/dmarc-db.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import path from 'node:path';
import { parseDmarcXml } from '#app/lib/dmarc/parser';
import {
  decompressAttachment,
  DmarcAttachmentTooLargeError,
  DMARC_MAX_DECOMPRESSED_BYTES,
} from '#app/lib/dmarc/mime';
import {
  DMARC_MAX_MAIL_BYTES,
  handleDmarcSnsRequest,
  resetDmarcTopicWarning,
  type DmarcSnsDeps,
  type StoreDmarcReportInput,
} from '#app/lib/dmarc/sns-dmarc';
import { resetSnsCertCache, verifySnsMessage } from '#app/lib/sns/verifier';
import { signedEnvelope, SNS_PUBLIC_KEY_PEM } from './support/inbound-fixtures';
import {
  DMARC_BUCKET,
  DMARC_TOPIC_ARN,
  OTHER_DMARC_TOPIC_ARN,
  dmarcConfirmationBody,
  dmarcNotificationBody,
  dmarcReceiptNotification,
  dmarcReportMail,
  dmarcReportXml,
  objectStream,
  sesSubscriptionSucceededNotice,
} from './support/dmarc-fixtures';

// =============================================================================
// Fixtures
// =============================================================================

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/dmarc');

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function readFixtureBuffer(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

let googleXml: string;
let yahooXml: string;
let microsoftXml: string;
let googleGzipBuf: Buffer;
let yahooZipBuf: Buffer;

beforeAll(() => {
  googleXml = readFixture('google-report.xml');
  yahooXml = readFixture('yahoo-report.xml');
  microsoftXml = readFixture('microsoft-report.xml');

  // Generate compressed variants programmatically
  const googleBuf = readFixtureBuffer('google-report.xml');
  googleGzipBuf = Buffer.from(gzipSync(googleBuf));

  const yahooBuf = readFixtureBuffer('yahoo-report.xml');
  const zipped = zipSync({ 'yahoo-report.xml': new Uint8Array(yahooBuf) });
  yahooZipBuf = Buffer.from(zipped);
});

// =============================================================================
// 1. Parse Google XML
// =============================================================================

describe('parseDmarcXml — Google report', () => {
  it('parses orgName and reportId', () => {
    const report = parseDmarcXml(googleXml);
    expect(report.orgName).toBe('Google Inc.');
    expect(report.reportId).toBe('12345678901234567890');
  });

  it('parses policyDomain', () => {
    const report = parseDmarcXml(googleXml);
    expect(report.policyDomain).toBe('example.com');
  });

  it('has one record', () => {
    const report = parseDmarcXml(googleXml);
    expect(report.records).toHaveLength(1);
  });

  it('record has correct sourceIp and count', () => {
    const report = parseDmarcXml(googleXml);
    const rec = report.records[0]!;
    expect(rec.sourceIp).toBe('209.85.128.41');
    expect(rec.count).toBe(3);
  });

  it('record dkimEval=pass spfEval=pass', () => {
    const report = parseDmarcXml(googleXml);
    const rec = report.records[0]!;
    expect(rec.dkimEval).toBe('pass');
    expect(rec.spfEval).toBe('pass');
  });

  it('parses policy fields', () => {
    const report = parseDmarcXml(googleXml);
    expect(report.policyAdkim).toBe('r');
    expect(report.policyAspf).toBe('r');
    expect(report.policyP).toBe('none');
    expect(report.policySp).toBe('none');
    expect(report.policyPct).toBe(100);
  });

  it('parses dateRange as epoch numbers', () => {
    const report = parseDmarcXml(googleXml);
    expect(report.dateRangeBegin).toBe(1745366400);
    expect(report.dateRangeEnd).toBe(1745452799);
  });
});

// =============================================================================
// 2. Parse Yahoo XML
// =============================================================================

describe('parseDmarcXml — Yahoo report', () => {
  it('orgName is Yahoo! Inc.', () => {
    const report = parseDmarcXml(yahooXml);
    expect(report.orgName).toBe('Yahoo! Inc.');
  });

  it('record spfEval=fail', () => {
    const report = parseDmarcXml(yahooXml);
    expect(report.records[0]!.spfEval).toBe('fail');
  });

  it('record dkimEval=pass', () => {
    const report = parseDmarcXml(yahooXml);
    expect(report.records[0]!.dkimEval).toBe('pass');
  });
});

// =============================================================================
// 3. Parse Microsoft XML — two records
// =============================================================================

describe('parseDmarcXml — Microsoft report', () => {
  it('has two records', () => {
    const report = parseDmarcXml(microsoftXml);
    expect(report.records).toHaveLength(2);
  });

  it('first record pass/pass, second record fail/fail', () => {
    const report = parseDmarcXml(microsoftXml);
    expect(report.records[0]!.dkimEval).toBe('pass');
    expect(report.records[0]!.spfEval).toBe('pass');
    expect(report.records[1]!.dkimEval).toBe('fail');
    expect(report.records[1]!.spfEval).toBe('fail');
  });

  it('orgName is Outlook.com', () => {
    const report = parseDmarcXml(microsoftXml);
    expect(report.orgName).toBe('Outlook.com');
  });
});

// =============================================================================
// 4. Parse gzip variant
// =============================================================================

describe('decompressAttachment — gzip', () => {
  it('decompresses and parses Google XML', async () => {
    const xml = await decompressAttachment(googleGzipBuf);
    const report = parseDmarcXml(xml);
    expect(report.orgName).toBe('Google Inc.');
    expect(report.records).toHaveLength(1);
  });
});

// =============================================================================
// 5. Parse zip variant
// =============================================================================

describe('decompressAttachment — zip', () => {
  it('decompresses and parses Yahoo XML', async () => {
    const xml = await decompressAttachment(yahooZipBuf);
    const report = parseDmarcXml(xml);
    expect(report.orgName).toBe('Yahoo! Inc.');
    expect(report.records[0]!.spfEval).toBe('fail');
  });
});

describe('parseDmarcXml — report identity', () => {
  it('parsing the same XML twice produces same reportId', () => {
    const r1 = parseDmarcXml(googleXml);
    const r2 = parseDmarcXml(googleXml);
    expect(r1.reportId).toBe(r2.reportId);
  });
});

describe('parseDmarcXml — records', () => {
  it('records have sourceIp and count from XML', () => {
    const report = parseDmarcXml(googleXml);
    const rec = report.records[0]!;
    expect(rec.sourceIp).toBe('209.85.128.41');
    expect(rec.count).toBe(3);
    expect(rec.disposition).toBe('none');
    expect(rec.headerFrom).toBe('example.com');
  });

  it('Microsoft report records have correct IPs', () => {
    const report = parseDmarcXml(microsoftXml);
    expect(report.records[0]!.sourceIp).toBe('40.107.92.100');
    expect(report.records[1]!.sourceIp).toBe('104.47.58.100');
  });

  it('spfAuthResults are populated from XML', () => {
    const report = parseDmarcXml(googleXml);
    const rec = report.records[0]!;
    expect(rec.spfAuthResults).toHaveLength(1);
    expect(rec.spfAuthResults[0]!.domain).toBe('mail.example.com');
    expect(rec.spfAuthResults[0]!.result).toBe('pass');
  });

  it('dkimAuthResults are populated from XML', () => {
    const report = parseDmarcXml(googleXml);
    const rec = report.records[0]!;
    expect(rec.dkimAuthResults).toHaveLength(1);
    expect(rec.dkimAuthResults[0]!.selector).toBe('pigeon');
    expect(rec.dkimAuthResults[0]!.result).toBe('pass');
  });
});

// =============================================================================
// 9. Invalid XML → parseDmarcXml throws
// =============================================================================

describe('invalid XML handling', () => {
  it('parseDmarcXml throws on invalid XML', () => {
    expect(() => parseDmarcXml('not xml at all')).toThrow();
  });

  it('parseDmarcXml throws on XML missing feedback root', () => {
    expect(() => parseDmarcXml('<root><foo>bar</foo></root>')).toThrow('missing <feedback>');
  });

  it('parseDmarcXml throws when report_id is missing', () => {
    const xmlMissingReportId = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>Test</org_name>
    <date_range><begin>0</begin><end>0</end></date_range>
  </report_metadata>
  <policy_published><domain>test.com</domain></policy_published>
</feedback>`;
    expect(() => parseDmarcXml(xmlMissingReportId)).toThrow('missing <report_id>');
  });
});

// =============================================================================
// 10. Decompression caps
// =============================================================================

/** Compresses to a few KB, inflates past the 20 MB cap. */
function bombPayload(): Uint8Array {
  return new Uint8Array(DMARC_MAX_DECOMPRESSED_BYTES + 1024);
}

let gzipBomb: Buffer;
let zipBomb: Buffer;

beforeAll(() => {
  gzipBomb = Buffer.from(gzipSync(bombPayload()));
  zipBomb = Buffer.from(zipSync({ 'bomb.xml': bombPayload() }));
});

describe('decompressAttachment — size caps', () => {
  it('refuses a gzip attachment that inflates past the cap', async () => {
    await expect(decompressAttachment(gzipBomb)).rejects.toBeInstanceOf(DmarcAttachmentTooLargeError);
  });

  it('refuses a zip entry whose declared size is past the cap', async () => {
    await expect(decompressAttachment(zipBomb)).rejects.toBeInstanceOf(DmarcAttachmentTooLargeError);
  });

  it('refuses a zip entry that declares more than the cap before inflating it (fflate allocates the declared size)', async () => {
    const zipped = Buffer.from(zipSync({ 'report.xml': new TextEncoder().encode(dmarcReportXml()) }));
    const centralDirectory = zipped.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralDirectory).toBeGreaterThan(0);
    zipped.writeUInt32LE(DMARC_MAX_DECOMPRESSED_BYTES + 1, centralDirectory + 24);
    await expect(decompressAttachment(zipped)).rejects.toBeInstanceOf(DmarcAttachmentTooLargeError);
  });

  it('refuses a zip entry whose real output is past the cap although its declared size is small', async () => {
    // A stored (uncompressed) entry, with the central directory lying about its size.
    const stored = Buffer.from(zipSync({ 'liar.xml': [bombPayload(), { level: 0 }] }));
    const centralDirectory = stored.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralDirectory).toBeGreaterThan(0);
    stored.writeUInt32LE(100, centralDirectory + 24);
    await expect(decompressAttachment(stored)).rejects.toBeInstanceOf(DmarcAttachmentTooLargeError);
  });

  it('reads the .xml entry of a zip even when another entry comes first', async () => {
    const zipped = Buffer.from(
      zipSync({ 'readme.txt': new TextEncoder().encode('not the report'), 'report.xml': new TextEncoder().encode(dmarcReportXml()) }),
    );
    const report = parseDmarcXml(await decompressAttachment(zipped));
    expect(report.policyDomain).toBe('example.org');
  });
});

// =============================================================================
// 11. POST /v1/webhooks/dmarc
// =============================================================================

interface Harness {
  deps: DmarcSnsDeps;
  stored: StoreDmarcReportInput[];
  opened: Array<{ bucket: string; key: string }>;
  confirmed: string[];
  verified: number;
  logs: string[];
}

function gzipAttachment(xml: string = dmarcReportXml()) {
  return {
    filename: 'reporter.example.com!example.org!1762560000!1762646399.xml.gz',
    contentType: 'application/gzip',
    content: Buffer.from(gzipSync(Buffer.from(xml, 'utf8'))),
  };
}

function harness(opts: { mail?: Buffer; contentLength?: number | null; topicArn?: string | undefined } = {}): Harness {
  const stored: StoreDmarcReportInput[] = [];
  const opened: Harness['opened'] = [];
  const confirmed: string[] = [];
  const logs: string[] = [];
  const counters = { verified: 0 };
  const mail = opts.mail ?? dmarcReportMail([gzipAttachment()]);
  const record = (level: string) => (message: string, meta?: unknown) => {
    logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  };
  const deps: DmarcSnsDeps = {
    topicArn: 'topicArn' in opts ? opts.topicArn : DMARC_TOPIC_ARN,
    log: { info: record('info'), warn: record('warn'), error: record('error') } as DmarcSnsDeps['log'],
    verify: (envelope) => {
      counters.verified += 1;
      return verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM });
    },
    confirmSubscription: async (url) => {
      confirmed.push(url);
      return true;
    },
    openObject: async (location) => {
      opened.push(location);
      return objectStream(mail, { contentLength: opts.contentLength });
    },
    storeReport: async (input) => {
      stored.push(input);
      return { id: stored.length };
    },
  };
  return {
    deps,
    stored,
    opened,
    confirmed,
    get verified() {
      return counters.verified;
    },
    logs,
  };
}

beforeEach(() => {
  resetSnsCertCache();
  resetDmarcTopicWarning();
});

describe('DMARC SNS route — topic and signature', () => {
  it('answers 503 while DMARC_SNS_TOPIC_ARN is unset and warns once per process', async () => {
    const h = harness({ topicArn: undefined });
    const first = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    const second = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(h.logs.filter((line) => line.startsWith('warn DMARC_SNS_TOPIC_ARN'))).toHaveLength(1);
    expect(h.opened).toHaveLength(0);
  });

  it('rejects a correctly signed notification from another topic with 403 and fetches nothing', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({
      rawBody: dmarcNotificationBody(dmarcReceiptNotification(), { topicArn: OTHER_DMARC_TOPIC_ARN }),
      deps: h.deps,
    });
    expect(response.status).toBe(403);
    expect(h.opened).toHaveLength(0);
    expect(h.verified).toBe(0);
    expect(h.stored).toHaveLength(0);
  });

  it('does not confirm a SubscriptionConfirmation from another topic', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({
      rawBody: dmarcConfirmationBody({ topicArn: OTHER_DMARC_TOPIC_ARN }),
      deps: h.deps,
    });
    expect(response.status).toBe(403);
    expect(h.confirmed).toHaveLength(0);
  });

  it('confirms a SubscriptionConfirmation from the configured topic', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({ rawBody: dmarcConfirmationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(h.confirmed).toEqual(['https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=dmarc-token']);
  });

  it('rejects a tampered message with 400 and fetches nothing', async () => {
    const h = harness();
    const envelope = JSON.parse(dmarcNotificationBody()) as Record<string, unknown>;
    envelope.Message = JSON.stringify(dmarcReceiptNotification({ objectKey: 'incoming/test/other-object' }));
    const response = await handleDmarcSnsRequest({ rawBody: JSON.stringify(envelope), deps: h.deps });
    expect(response.status).toBe(400);
    expect(h.opened).toHaveLength(0);
  });
});

const HOSTILE_SUBSCRIBE_URLS = [
  'http://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
  'https://attacker.example/?Action=ConfirmSubscription&Token=t',
  'https://sns.eu-central-1.amazonaws.com:8443/?Action=ConfirmSubscription&Token=t',
  'https://user@sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
  'https://sns.eu-central-1.amazonaws.com.evil.example/?Action=ConfirmSubscription&Token=t',
];

describe('DMARC SNS route: SubscribeURL host check', () => {
  it.each(HOSTILE_SUBSCRIBE_URLS)('refuses a correctly signed confirmation for %s and fetches nothing', async (subscribeUrl) => {
    const h = harness();
    const rawBody = JSON.stringify(
      signedEnvelope({ type: 'SubscriptionConfirmation', message: 'confirm', topicArn: DMARC_TOPIC_ARN, subscribeUrl }),
    );
    const response = await handleDmarcSnsRequest({ rawBody, deps: h.deps });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid SubscribeURL' });
    expect(h.verified).toBe(1);
    expect(h.confirmed).toHaveLength(0);
  });
});

describe('DMARC SNS route — notifications that are not reports', () => {
  it('ignores the SES subscription notice with 200 and no S3 read, without quoting it', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({
      rawBody: dmarcNotificationBody(sesSubscriptionSucceededNotice()),
      deps: h.deps,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ignored: true });
    expect(h.opened).toHaveLength(0);
    expect(h.logs.join('\n')).not.toContain('successfully subscribed');
  });

  it('skips the SES setup test object with 200 and no S3 read', async () => {
    const h = harness();
    const notification = dmarcReceiptNotification({
      messageId: 'AMAZON_SES_SETUP_NOTIFICATION',
      objectKey: 'incoming/test/AMAZON_SES_SETUP_NOTIFICATION',
    });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(notification), deps: h.deps });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: 'setup_notification' });
    expect(h.opened).toHaveLength(0);
  });

  it('skips a mail with virus verdict FAIL with 200 and no S3 read', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({
      rawBody: dmarcNotificationBody(dmarcReceiptNotification({ virus: 'FAIL' })),
      deps: h.deps,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: 'virus' });
    expect(h.opened).toHaveLength(0);
  });
});

describe('DMARC SNS route — size limits', () => {
  it('refuses an S3 object whose Content-Length is over 10 MB, before reading it', async () => {
    const mail = dmarcReportMail([gzipAttachment()]);
    const h = harness({ mail, contentLength: DMARC_MAX_MAIL_BYTES + 1 });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: 'too_large' });
    expect(h.opened).toHaveLength(1);
    expect(h.stored).toHaveLength(0);
  });

  it('refuses an S3 object that streams past 10 MB when no Content-Length is given', async () => {
    const h = harness({ mail: Buffer.alloc(DMARC_MAX_MAIL_BYTES + 1, 0x41), contentLength: null });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: 'too_large' });
    expect(h.stored).toHaveLength(0);
  });

  it('skips a gzip bomb attachment and still stores the real report beside it', async () => {
    const mail = dmarcReportMail([
      { filename: 'bomb.xml.gz', contentType: 'application/gzip', content: gzipBomb },
      gzipAttachment(),
    ]);
    const h = harness({ mail });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: 1, skipped: 1 });
    expect(h.stored).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('over the decompression cap'))).toBe(true);
  });

  it('skips a zip bomb attachment with 200', async () => {
    const mail = dmarcReportMail([{ filename: 'bomb.zip', contentType: 'application/zip', content: zipBomb }]);
    const h = harness({ mail });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: 0, skipped: 1 });
    expect(h.stored).toHaveLength(0);
    expect(h.logs.some((line) => line.includes('over the decompression cap'))).toBe(true);
  });
});

describe('DMARC SNS route — receipt notification to stored report', () => {
  it('reads the object the receipt names and stores the report with that key', async () => {
    const h = harness();
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(h.opened).toEqual([{ bucket: DMARC_BUCKET, key: 'incoming/test/o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1' }]);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]).toMatchObject({
      sourceS3Key: 'incoming/test/o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1',
      sourceMessageId: 'sns-dmarc-0001',
      report: { policyDomain: 'example.org' },
    });
  });

  it('answers 500 on an S3 error so SNS retries', async () => {
    const h = harness();
    h.deps.openObject = async () => {
      throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    };
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(500);
  });

  it('answers 500 on a storage error so SNS retries', async () => {
    const h = harness();
    h.deps.storeReport = async () => {
      throw new Error('connection terminated');
    };
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(500);
  });

  it('answers 200 for a report whose XML does not parse', async () => {
    const h = harness({ mail: dmarcReportMail([gzipAttachment('<root>not a report</root>')]) });
    const response = await handleDmarcSnsRequest({ rawBody: dmarcNotificationBody(), deps: h.deps });
    expect(response.status).toBe(200);
    expect(h.stored).toHaveLength(0);
  });
});
