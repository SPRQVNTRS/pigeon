/**
 * DMARC ingest end to end against a real throwaway Postgres (local:
 * DB_PORT=5433 pnpm test): a faithful SES receipt notification for a raw
 * report mail with a gzip attachment becomes one dmarc_reports row and its
 * dmarc_records, and a redelivery leaves exactly that.
 */
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { SNS_PUBLIC_KEY_PEM } from './support/inbound-fixtures';
import {
  DMARC_TOPIC_ARN,
  dmarcNotificationBody,
  dmarcReceiptNotification,
  dmarcReportMail,
  dmarcReportXml,
  objectStream,
} from './support/dmarc-fixtures';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

const { handleDmarcSnsRequest } = await import('#app/lib/dmarc/sns-dmarc');
const { storeDmarcReport } = await import('#app/models/dmarc-reports.server');
const { verifySnsMessage, resetSnsCertCache } = await import('#app/lib/sns/verifier');
const { dmarcReports, dmarcRecords } = await import('#drizzle/schema/index');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function deliver(rawBody: string): Promise<Response> {
  const mail = dmarcReportMail([
    {
      filename: 'reporter.example.com!example.org!1762560000!1762646399.xml.gz',
      contentType: 'application/gzip',
      content: Buffer.from(gzipSync(Buffer.from(dmarcReportXml(), 'utf8'))),
    },
  ]);
  return handleDmarcSnsRequest({
    rawBody,
    deps: {
      topicArn: DMARC_TOPIC_ARN,
      log: silentLog,
      verify: (envelope) => verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM }),
      confirmSubscription: async () => true,
      openObject: async () => objectStream(mail),
      storeReport: (input) => storeDmarcReport({ ...input, db: testDb.db }),
    },
  });
}

describe('DMARC ingest (real Postgres)', () => {
  it('stores one report for example.org with its records, and a redelivery changes nothing', async () => {
    resetSnsCertCache();
    const objectKey = 'incoming/test/o3vrnil0e2ic28trm7dfhrc2v0clambda4nbp0g1';
    const body = dmarcNotificationBody(dmarcReceiptNotification({ objectKey }));

    const first = await deliver(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, stored: 1, skipped: 0 });

    const second = await deliver(body);
    expect(second.status).toBe(200);

    const reports = await testDb.db.select().from(dmarcReports);
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report).toMatchObject({
      reportId: '17112233445566778899',
      orgName: 'reporter.example.com',
      policyDomain: 'example.org',
      policyP: 'none',
      policyPct: 100,
      sourceS3Key: objectKey,
      sourceMessageId: 'sns-dmarc-0001',
    });

    const records = await testDb.db
      .select()
      .from(dmarcRecords)
      .where(eq(dmarcRecords.dmarcReportId, report!.id))
      .orderBy(dmarcRecords.sourceIp);
    expect(records.map((record) => [record.sourceIp, record.count, record.dkimEval, record.spfEval])).toEqual([
      ['192.0.2.10', 4, 'pass', 'pass'],
      ['192.0.2.20', 1, 'fail', 'fail'],
    ]);
  }, 30_000);
});
