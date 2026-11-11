/**
 * Privacy guard: drive one sample mail through the inbound route, the
 * inbound.process worker and a failing email.received delivery, capture every
 * log call (all component loggers) and everything written to stdout/stderr,
 * plus every error thrown, and fail if an address, the subject or a body
 * snippet shows up anywhere. The mail carries an SES Authentication-Results
 * header, so the sender authentication code runs too: no domain it reads
 * (DKIM, SPF, the From domain) may show up either.
 */

import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  notificationBody,
  receiptNotification,
  receivedMail,
  SAMPLE,
  sesPrependedHeaders,
  SNS_PUBLIC_KEY_PEM,
  TOPIC_ARN,
} from './support/inbound-fixtures';

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('#app/lib/logger', () => {
  const record = (component: string, level: string) => (message: unknown, meta?: unknown) => {
    const metaText = JSON.stringify(meta ?? {}, (_key, value) =>
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    );
    captured.lines.push(`${component} ${level} ${String(message)} ${metaText}`);
  };
  const createComponentLogger = (component: string) => ({
    trace: record(component, 'trace'),
    debug: record(component, 'debug'),
    info: record(component, 'info'),
    warn: record(component, 'warn'),
    error: record(component, 'error'),
    fatal: record(component, 'fatal'),
    child: () => createComponentLogger(component),
  });
  return { createComponentLogger, logger: createComponentLogger('root') };
});

const HOOK = {
  id: 'wh_1',
  appId: 'app_klara',
  url: 'https://consumer.example.com/hook',
  signingSecret: 'secret',
  eventTypes: ['email.received'],
  enabled: true,
};

vi.mock('#drizzle/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [HOOK] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

const { verifySnsMessage, resetSnsCertCache } = await import('#app/lib/sns/verifier');
const { handleInboundSnsRequest } = await import('#app/lib/inbound/sns-inbound');
const { createComponentLogger } = await import('#app/lib/logger');
const { handleInboundProcess } = await import('#app/workflows/inbound-process');
const { __test__: deliver } = await import('#app/workflows/webhook-deliver');

const FORBIDDEN = [
  SAMPLE.from,
  SAMPLE.fromName,
  SAMPLE.recipient,
  SAMPLE.secondRecipient,
  SAMPLE.unknownRecipient,
  SAMPLE.subject,
  'Privacy probe subject',
  'canary-7f3e1d',
  'never log me',
  // Domains the sender authentication reads from the SES header.
  'dkim-canary',
  'spf-canary',
];

/** The From domain on its own (not inside an address or a longer host name). */
const BARE_FROM_DOMAIN = /(?<![\w.@-])example\.com/;

const SES_RESULTS = [
  'spf=pass (spfCheck: designates) client-ip=192.0.2.8; envelope-from=bounce@spf-canary.example.net; helo=mx.example.net',
  'dkim=pass header.d=example.com',
  'dkim=pass header.i=@dkim-canary.example.net',
  'dmarc=pass header.from=example.com',
];

const written: string[] = [];
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);

beforeAll(() => {
  resetSnsCertCache();
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalStdout as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalStderr as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

afterAll(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
});

function expectClean(texts: readonly string[]): void {
  const all = texts.join('\n');
  for (const value of FORBIDDEN) expect(all, `leaked: ${value}`).not.toContain(value);
  expect(all, 'leaked: the From domain').not.toMatch(BARE_FROM_DOMAIN);
}

describe('inbound privacy', () => {
  it('no address, subject or body reaches a log line, stdout/stderr or an error', async () => {
    const recipients = [SAMPLE.recipient, SAMPLE.secondRecipient, SAMPLE.unknownRecipient];
    const raw = receivedMail({ prepended: sesPrependedHeaders({ results: SES_RESULTS }) });
    const errors: string[] = [];
    const rows: Array<Record<string, unknown>> = [];
    const queued: Array<{ inboundEmailId: string; appId: string }> = [];
    const deliveries: Array<Record<string, unknown>> = [];

    // 1. Route
    const res = await handleInboundSnsRequest({
      rawBody: notificationBody(receiptNotification({ recipients })),
      deps: {
        topicArn: TOPIC_ARN,
        log: createComponentLogger('InboundWebhookRoute'),
        verify: (envelope) => verifySnsMessage(envelope, { fetchCert: async () => SNS_PUBLIC_KEY_PEM }),
        confirmSubscription: async () => true,
        findDomains: async () => [{ id: 'dom_1', appId: 'app_klara', name: 'reply.example.test' }],
        insertEmail: async (values) => {
          rows.push({ ...values, id: 'ie_1', createdAt: new Date() });
          return { id: 'ie_1' };
        },
        deleteEmail: async () => undefined,
        enqueue: async (payload) => {
          queued.push(payload);
        },
      },
    });
    expect(res.status).toBe(200);
    expect(queued).toEqual([{ inboundEmailId: 'ie_1', appId: 'app_klara' }]);
    expect(JSON.stringify(queued)).not.toContain('@');

    // 2. Worker: success path, then the S3-failure and stream-failure paths.
    const boss = {
      send: async (_name: string, data: object) => {
        deliveries.push(data as Record<string, unknown>);
        return 'job-1';
      },
    };
    // The sender hash write: what goes into the row must not be the address.
    const storedHashes: string[] = [];
    const baseDeps = {
      boss,
      storeSenderHash: async (stored: { appId: string; id: string; senderHash: string }) => {
        storedHashes.push(JSON.stringify(stored));
        return { id: stored.id };
      },
      loadEmail: async () => rows[0] as never,
      openObject: async () => ({ body: Readable.from([raw]), contentLength: raw.length }),
    };
    expect(await handleInboundProcess({ data: queued[0], deps: baseDeps })).toBe('processed');
    expect(deliveries).toHaveLength(2);

    for (const failingDeps of [
      { ...baseDeps, openObject: async () => Promise.reject(new Error(`denied for ${SAMPLE.recipient}`)) },
      {
        ...baseDeps,
        openObject: async () => ({
          body: new Readable({ read() { this.destroy(new Error('cut')); } }),
          contentLength: 10,
        }),
      },
    ]) {
      try {
        await handleInboundProcess({ data: queued[0], deps: failingDeps });
      } catch (err) {
        // The whole error as pg-boss 10 stores it in the job row.
        errors.push(JSON.stringify(err, Object.getOwnPropertyNames(err)));
      }
    }
    expect(errors).toHaveLength(2);

    // 3. A failing email.received delivery whose receiver echoes the payload back.
    // The receiver answers 500 and echoes the event data (sender first) back.
    const echo = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { data } = JSON.parse(String(init?.body)) as { data: Record<string, unknown> };
      return new Response(JSON.stringify({ from: data.from, subject: data.subject, data }), { status: 500 });
    });
    try {
      await deliver.handleInboundWebhookDeliver([{ data: deliveries[0] as never }]);
    } catch (err) {
      errors.push(JSON.stringify(err, Object.getOwnPropertyNames(err)));
    } finally {
      echo.mockRestore();
    }
    expect(errors).toHaveLength(3);

    // Control: the sample values really were in the payload we delivered.
    expect(JSON.stringify(deliveries)).toContain(SAMPLE.from);
    expect(JSON.stringify(deliveries)).toContain('canary-7f3e1d');
    expect(JSON.stringify(deliveries)).toContain('"from_authenticated":true');
    expect(JSON.stringify(deliveries)).toContain('dkim-canary.example.net');
    expect(JSON.stringify(deliveries)).toContain('spf-canary.example.net');
    expect(JSON.stringify(deliveries)).toMatch(BARE_FROM_DOMAIN);
    // The worker logs the booleans, never the domains.
    expect(captured.lines.some((line) => line.includes('"fromAuthenticated":true') && line.includes('"sesHeaderTrusted":true'))).toBe(true);
    expect(captured.lines.length).toBeGreaterThan(3);
    expect(storedHashes).toHaveLength(1);

    expectClean(captured.lines);
    expectClean(written);
    expectClean(errors);
    expectClean(storedHashes);
  });
});
