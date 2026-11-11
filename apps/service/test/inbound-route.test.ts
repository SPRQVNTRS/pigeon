/**
 * POST /v1/webhooks/inbound request handling, with real SNS signature
 * verification (a test RSA key stands in for the AWS cert) and in-memory
 * stand-ins for the database and pg-boss.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetSnsCertCache, verifySnsMessage } from '#app/lib/sns/verifier';
import {
  handleInboundSnsRequest,
  resetInboundTopicWarning,
  type InboundSnsDeps,
  type NewInboundEmail,
} from '#app/lib/inbound/sns-inbound';
import {
  notificationBody,
  OTHER_TOPIC_ARN,
  receiptNotification,
  SAMPLE,
  signedEnvelope,
  SNS_PUBLIC_KEY_PEM,
  TOPIC_ARN,
} from './support/inbound-fixtures';

const DOMAIN = { id: 'dom_1', appId: 'app_klara', name: 'reply.example.test' };

interface Harness {
  deps: InboundSnsDeps;
  rows: Array<NewInboundEmail & { id: string }>;
  queued: Array<{ inboundEmailId: string; appId: string }>;
  logs: string[];
  confirmed: string[];
}

function harness(overrides: Partial<InboundSnsDeps> = {}): Harness {
  const rows: Harness['rows'] = [];
  const queued: Harness['queued'] = [];
  const logs: string[] = [];
  const confirmed: string[] = [];
  const record = (level: string) => (message: string, meta?: unknown) => {
    logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  };
  const deps: InboundSnsDeps = {
    topicArn: TOPIC_ARN,
    log: { info: record('info'), warn: record('warn'), error: record('error') } as InboundSnsDeps['log'],
    verify: (envelope) => verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM }),
    confirmSubscription: async (url) => {
      confirmed.push(url);
      return true;
    },
    findDomains: async (names) => (names.includes(DOMAIN.name) ? [DOMAIN] : []),
    // Same uniqueness as the real index: (ses_message_id, inbound_domain_id).
    insertEmail: async (values) => {
      const exists = rows.some(
        (row) => row.sesMessageId === values.sesMessageId && row.inboundDomainId === values.inboundDomainId,
      );
      if (exists) return null;
      const row = { ...values, id: `ie_${rows.length + 1}` };
      rows.push(row);
      return { id: row.id };
    },
    deleteEmail: async ({ id }) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    enqueue: async (payload) => {
      queued.push(payload);
    },
    ...overrides,
  };
  return { deps, rows, queued, logs, confirmed };
}

beforeEach(() => {
  resetSnsCertCache();
  resetInboundTopicWarning();
});

describe('inbound SNS route', () => {
  it('stores one row per matched domain and queues inbound.process with ids only', async () => {
    const h = harness();
    const res = await handleInboundSnsRequest({
      rawBody: notificationBody(
        receiptNotification({ recipients: [SAMPLE.recipient, SAMPLE.secondRecipient, SAMPLE.unknownRecipient] }),
      ),
      deps: h.deps,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: 1, duplicates: 0 });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      appId: 'app_klara',
      inboundDomainId: 'dom_1',
      sesMessageId: 'ses-message-0001',
      s3Bucket: 'example-pigeon-inbound',
      s3Key: 'incoming/test/ses-message-0001',
      recipientCount: 2,
      recipients: [SAMPLE.recipient, SAMPLE.secondRecipient],
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' },
    });
    expect(h.queued).toEqual([{ inboundEmailId: 'ie_1', appId: 'app_klara' }]);
    expect(h.logs.some((line) => line.includes('"unmatchedRecipients":1'))).toBe(true);
  });

  it('stores the receipt dmarc verdict in the row verdicts', async () => {
    const h = harness();
    const verdicts = { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' };
    const res = await handleInboundSnsRequest({ rawBody: notificationBody(receiptNotification({ verdicts })), deps: h.deps });

    expect(res.status).toBe(200);
    expect(h.rows[0]?.verdicts).toEqual(verdicts);
  });

  it('a duplicate SNS delivery of the same mail fans out once', async () => {
    const h = harness();
    const body = notificationBody(receiptNotification(), { messageId: 'sns-a' });
    const retry = notificationBody(receiptNotification(), { messageId: 'sns-b' });

    const first = await handleInboundSnsRequest({ rawBody: body, deps: h.deps });
    const second = await handleInboundSnsRequest({ rawBody: retry, deps: h.deps });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, queued: 0, duplicates: 1 });
    expect(h.queued).toHaveLength(1);
  });

  it('rejects a bad signature with 400 and stores nothing', async () => {
    const h = harness();
    const envelope = signedEnvelope({ message: JSON.stringify(receiptNotification()) });
    const tampered = { ...envelope, Message: JSON.stringify(receiptNotification({ messageId: 'forged' })) };

    const res = await handleInboundSnsRequest({ rawBody: JSON.stringify(tampered), deps: h.deps });
    expect(res.status).toBe(400);
    expect(h.rows).toEqual([]);
    expect(h.queued).toEqual([]);
  });

  it('rejects a correctly signed message from another topic with 403', async () => {
    const h = harness();
    const res = await handleInboundSnsRequest({
      rawBody: notificationBody(receiptNotification(), { topicArn: OTHER_TOPIC_ARN }),
      deps: h.deps,
    });
    expect(res.status).toBe(403);
    expect(h.rows).toEqual([]);
  });

  it('confirms a subscription only for the configured topic', async () => {
    const h = harness();
    const ok = await handleInboundSnsRequest({
      rawBody: JSON.stringify(signedEnvelope({ type: 'SubscriptionConfirmation', message: 'confirm' })),
      deps: h.deps,
    });
    expect(ok.status).toBe(200);
    expect(h.confirmed).toHaveLength(1);

    const other = await handleInboundSnsRequest({
      rawBody: JSON.stringify(
        signedEnvelope({ type: 'SubscriptionConfirmation', message: 'confirm', topicArn: OTHER_TOPIC_ARN }),
      ),
      deps: h.deps,
    });
    expect(other.status).toBe(403);
    expect(h.confirmed).toHaveLength(1);
  });

  it.each([
    'http://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    'https://attacker.example/?Action=ConfirmSubscription&Token=t',
    'https://sns.eu-central-1.amazonaws.com:8443/?Action=ConfirmSubscription&Token=t',
    'https://user@sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    'https://sns.eu-central-1.amazonaws.com.evil.example/?Action=ConfirmSubscription&Token=t',
  ])('refuses a correctly signed confirmation for %s and fetches nothing', async (subscribeUrl) => {
    const h = harness();
    const res = await handleInboundSnsRequest({
      rawBody: JSON.stringify(signedEnvelope({ type: 'SubscriptionConfirmation', message: 'confirm', subscribeUrl })),
      deps: h.deps,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid SubscribeURL' });
    expect(h.confirmed).toHaveLength(0);
  });

  it('checks the topic before it verifies the signature or fetches anything', async () => {
    const verify = vi.fn(async () => true);
    const h = harness({ verify });
    const res = await handleInboundSnsRequest({
      rawBody: JSON.stringify(
        signedEnvelope({ type: 'SubscriptionConfirmation', message: 'confirm', topicArn: OTHER_TOPIC_ARN }),
      ),
      deps: h.deps,
    });
    expect(res.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect(h.confirmed).toHaveLength(0);
  });

  it('answers 503 while INBOUND_SNS_TOPIC_ARN is unset and warns once', async () => {
    const h = harness({ topicArn: undefined });
    const body = notificationBody();
    expect((await handleInboundSnsRequest({ rawBody: body, deps: h.deps })).status).toBe(503);
    expect((await handleInboundSnsRequest({ rawBody: body, deps: h.deps })).status).toBe(503);
    expect(h.logs.filter((line) => line.startsWith('warn INBOUND_SNS_TOPIC_ARN'))).toHaveLength(1);
    expect(h.rows).toEqual([]);
  });

  it('answers 200 with a warning for a notification that is not an SES receipt', async () => {
    const h = harness();
    const res = await handleInboundSnsRequest({
      rawBody: JSON.stringify(signedEnvelope({ message: '{"notificationType":"Bounce"}' })),
      deps: h.deps,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(h.logs.some((line) => line.startsWith('warn Inbound notification is not an SES S3 receipt'))).toBe(true);
  });

  it('answers 500 on a database error so SNS retries', async () => {
    const h = harness({
      findDomains: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await handleInboundSnsRequest({ rawBody: notificationBody(), deps: h.deps });
    expect(res.status).toBe(500);
  });

  it('removes the row again when the job cannot be queued, so the SNS retry processes the mail', async () => {
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('queue down')).mockResolvedValue(undefined);
    const h = harness({ enqueue });
    const body = notificationBody();

    expect((await handleInboundSnsRequest({ rawBody: body, deps: h.deps })).status).toBe(500);
    expect(h.rows).toEqual([]);

    expect((await handleInboundSnsRequest({ rawBody: body, deps: h.deps })).status).toBe(200);
    expect(h.rows).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('ignores recipients on no known domain without storing anything', async () => {
    const h = harness();
    const res = await handleInboundSnsRequest({
      rawBody: notificationBody(receiptNotification({ recipients: [SAMPLE.unknownRecipient] })),
      deps: h.deps,
    });
    expect(res.status).toBe(200);
    expect(h.rows).toEqual([]);
    expect(h.queued).toEqual([]);
  });
});
