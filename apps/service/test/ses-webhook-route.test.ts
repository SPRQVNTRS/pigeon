/**
 * POST /v1/webhooks/ses request handling, with real SNS signature
 * verification (a test RSA key stands in for the AWS cert) and an in-memory
 * stand-in for pg-boss.
 *
 * A foreign topic is signed with the same key as the configured one, so the
 * signature passes and only the topic check can reject it: that mirrors AWS,
 * which signs messages for every account with the same SNS cert.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetSnsCertCache, verifySnsMessage } from '#app/lib/sns/verifier';
import { handleSesSnsRequest, resetSesTopicWarning, type SesSnsDeps } from '#app/lib/ses/sns-ses-events';
import { isSnsSubscribeUrl } from '#app/lib/sns/subscribe-url';
import { parseSesSnsTopicArn } from '#app/config/ses';
import type { SesNotification } from '#app/workflows/ses-event-process';
import { signedEnvelope, SNS_PUBLIC_KEY_PEM } from './support/inbound-fixtures';

const SES_TOPIC_ARN = 'arn:aws:sns:eu-central-1:000000000000:pigeon-ses-events-test';
const FOREIGN_TOPIC_ARN = 'arn:aws:sns:eu-central-1:111111111111:attacker-topic';
const BODY_CANARY = 'complaint-canary-5b1e9f';

const COMPLAINT: SesNotification = {
  notificationType: 'Complaint',
  mail: {
    messageId: 'ses-msg-0001',
    timestamp: '2026-11-09T10:00:00.000Z',
    source: 'sender@example.com',
    destination: [`${BODY_CANARY}@example.test`],
  },
  complaint: {
    complainedRecipients: [{ emailAddress: `${BODY_CANARY}@example.test` }],
    timestamp: '2026-11-09T10:00:01.000Z',
  },
} as SesNotification;

type SnsType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
const SNS_TYPES: SnsType[] = ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'];

function body(opts: { type?: SnsType; topicArn?: string; subscribeUrl?: string } = {}): string {
  const type = opts.type ?? 'Notification';
  const message = type === 'Notification' ? JSON.stringify(COMPLAINT) : `confirm ${BODY_CANARY}`;
  return JSON.stringify(
    signedEnvelope({ type, message, topicArn: opts.topicArn ?? SES_TOPIC_ARN, subscribeUrl: opts.subscribeUrl }),
  );
}

interface Harness {
  deps: SesSnsDeps;
  queued: Array<{ notification: SesNotification }>;
  confirmed: string[];
  verifyCalls: number;
  logs: string[];
}

function harness(opts: { topicArn?: string | undefined } = {}): Harness {
  const h: Harness = {
    deps: undefined as unknown as SesSnsDeps,
    queued: [],
    confirmed: [],
    verifyCalls: 0,
    logs: [],
  };
  const record = (level: string) => (message: string, meta?: unknown) => {
    h.logs.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
  };
  h.deps = {
    topicArn: 'topicArn' in opts ? opts.topicArn : SES_TOPIC_ARN,
    log: { info: record('info'), warn: record('warn'), error: record('error') } as SesSnsDeps['log'],
    verify: (envelope) => {
      h.verifyCalls += 1;
      return verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM });
    },
    confirmSubscription: async (url) => {
      h.confirmed.push(url);
      return true;
    },
    enqueue: async (payload) => {
      h.queued.push(payload);
    },
  };
  return h;
}

function expectNoSideEffects(h: Harness): void {
  expect(h.queued).toEqual([]);
  expect(h.confirmed).toEqual([]);
}

beforeEach(() => {
  resetSnsCertCache();
  resetSesTopicWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SES SNS route: configured topic', () => {
  it('queues ses.event.process with the parsed notification', async () => {
    const h = harness();
    const res = await handleSesSnsRequest({ rawBody: body(), deps: h.deps });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    expect(h.queued).toEqual([{ notification: COMPLAINT }]);
    expect(h.logs.some((line) => line.startsWith('info Enqueued SES event'))).toBe(true);
  });

  it('confirms a SubscriptionConfirmation from the configured topic', async () => {
    const h = harness();
    const res = await handleSesSnsRequest({ rawBody: body({ type: 'SubscriptionConfirmation' }), deps: h.deps });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, confirmed: true });
    expect(h.confirmed).toEqual(['https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-1']);
  });

  it('answers an UnsubscribeConfirmation from the configured topic with a no-op 200', async () => {
    const h = harness();
    const res = await handleSesSnsRequest({ rawBody: body({ type: 'UnsubscribeConfirmation' }), deps: h.deps });

    expect(res.status).toBe(200);
    expectNoSideEffects(h);
  });

  it('rejects an invalid signature with 400 and queues nothing', async () => {
    const h = harness();
    const tampered = JSON.parse(body()) as Record<string, unknown>;
    tampered.Message = JSON.stringify({ ...COMPLAINT, notificationType: 'Bounce' });
    const res = await handleSesSnsRequest({ rawBody: JSON.stringify(tampered), deps: h.deps });

    expect(res.status).toBe(400);
    expectNoSideEffects(h);
  });

  it('refuses a SubscribeURL that is not an https SNS host and fetches nothing', async () => {
    const h = harness();
    const res = await handleSesSnsRequest({
      rawBody: body({ type: 'SubscriptionConfirmation', subscribeUrl: 'https://attacker.example.com/confirm' }),
      deps: h.deps,
    });

    expect(res.status).toBe(400);
    expectNoSideEffects(h);
  });
});

describe('SES SNS route: foreign topic', () => {
  it.each(SNS_TYPES)('rejects a correctly signed %s from another topic with 403 and does nothing', async (type) => {
    const h = harness();
    const res = await handleSesSnsRequest({ rawBody: body({ type, topicArn: FOREIGN_TOPIC_ARN }), deps: h.deps });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Unexpected topic' });
    expectNoSideEffects(h);
    expect(h.verifyCalls).toBe(0);
  });

  it('logs the rejected TopicArn and never the message body', async () => {
    const h = harness();
    await handleSesSnsRequest({ rawBody: body({ topicArn: FOREIGN_TOPIC_ARN }), deps: h.deps });

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain('warn SES SNS message from an unexpected topic, rejected');
    expect(h.logs[0]).toContain(FOREIGN_TOPIC_ARN);
    expect(h.logs.join('\n')).not.toContain(BODY_CANARY);
  });

  it('a SubscriptionConfirmation from another topic makes no outbound fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const h = harness();
    // Wire confirm the way the route does, so any fetch would hit the spy.
    h.deps.confirmSubscription = async (url) => (await fetch(url)).ok;

    const res = await handleSesSnsRequest({
      rawBody: body({ type: 'SubscriptionConfirmation', topicArn: FOREIGN_TOPIC_ARN }),
      deps: h.deps,
    });

    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('SES SNS route: topic not configured', () => {
  it.each(SNS_TYPES)('answers %s with 503 and does nothing', async (type) => {
    const h = harness({ topicArn: undefined });
    const res = await handleSesSnsRequest({ rawBody: body({ type }), deps: h.deps });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'SES event ingest is not configured' });
    expectNoSideEffects(h);
    expect(h.verifyCalls).toBe(0);
  });

  it('warns once per process, not once per request', async () => {
    const h = harness({ topicArn: undefined });
    await handleSesSnsRequest({ rawBody: body(), deps: h.deps });
    await handleSesSnsRequest({ rawBody: body(), deps: h.deps });

    expect(h.logs.filter((line) => line.includes('SES_SNS_TOPIC_ARN is not set'))).toHaveLength(1);
  });
});

describe('SES_SNS_TOPIC_ARN config', () => {
  it('is off when unset or empty', () => {
    expect(parseSesSnsTopicArn(undefined)).toBeUndefined();
    expect(parseSesSnsTopicArn('  ')).toBeUndefined();
  });

  it('returns a valid ARN trimmed', () => {
    expect(parseSesSnsTopicArn(` ${SES_TOPIC_ARN} `)).toBe(SES_TOPIC_ARN);
  });

  it('throws on a value that is not an SNS topic ARN', () => {
    expect(() => parseSesSnsTopicArn('pigeon-ses-events')).toThrow(/SES_SNS_TOPIC_ARN/);
  });
});

describe('isSnsSubscribeUrl', () => {
  it.each([
    ['https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t', true],
    ['http://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription', false],
    ['https://sns.eu-central-1.amazonaws.com.attacker.example/', false],
    ['https://sns.eu-central-1.amazonaws.com:8443/', false],
    ['https://user@attacker.example/?sns.eu-central-1.amazonaws.com', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isSnsSubscribeUrl(url)).toBe(expected);
  });
});
