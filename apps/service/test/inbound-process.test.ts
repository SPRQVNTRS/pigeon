/**
 * inbound.process worker: outcomes, payload shape and event-type filtering.
 * The database is mocked; app scoping of the webhook lookup is proven against
 * real SQL in inbound-db.test.ts, and the sender hash write in
 * recipient-erase.test.ts ("received mail from the address").
 */

import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { alternativeMail, plainMail, receivedMail, SAMPLE, sesPrependedHeaders } from './support/inbound-fixtures';

const state = vi.hoisted(() => ({ hooks: [] as Array<Record<string, unknown>> }));

vi.mock('#drizzle/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => state.hooks }) }),
  },
}));

const { handleInboundProcess } = await import('#app/workflows/inbound-process');
const { InboundMimeError } = await import('#app/lib/inbound/mime');
const { WEBHOOK_DELIVER_INBOUND_QUEUE } = await import('#app/lib/queue-names');
const { inboundSenderHash } = await import('#app/lib/inbound/sender-hash');

function hook(id: string, eventTypes: string[] | null) {
  return { id, appId: 'app_klara', url: `https://example.com/${id}`, signingSecret: `secret-${id}`, eventTypes, enabled: true };
}

const ROW = {
  id: 'ie_1',
  appId: 'app_klara',
  inboundDomainId: 'dom_1',
  sesMessageId: 'ses-message-0001',
  s3Bucket: 'example-pigeon-inbound',
  s3Key: 'incoming/test/ses-message-0001',
  receivedAt: new Date('2026-11-09T10:00:00.000Z'),
  recipientCount: 2,
  recipients: [SAMPLE.recipient, SAMPLE.secondRecipient],
  verdicts: { spf: 'PASS', dkim: 'FAIL', spam: 'PASS', virus: 'PASS' },
  senderHash: null,
  createdAt: new Date('2026-11-09T10:00:01.000Z'),
};

type StoredHash = { appId: string; id: string; senderHash: string };

function makeBoss() {
  const sends: Array<{ name: string; data: Record<string, unknown>; options: unknown }> = [];
  return {
    sends,
    send: async (name: string, data: object, options?: Record<string, unknown>) => {
      sends.push({ name, data: data as Record<string, unknown>, options });
      return `job-${sends.length}`;
    },
  };
}

function deps(boss: ReturnType<typeof makeBoss>, raw: Buffer = plainMail(), hashes: StoredHash[] = [], row: typeof ROW = ROW) {
  return {
    boss,
    storeSenderHash: async (stored: StoredHash) => {
      hashes.push(stored);
      return { id: stored.id };
    },
    loadEmail: async ({ appId, id }: { appId: string; id: string }) => (appId === row.appId && id === row.id ? row : null),
    openObject: async () => ({ body: Readable.from([raw]), contentLength: raw.length }),
  };
}

beforeEach(() => {
  state.hooks = [
    hook('wh_received', ['email.received']),
    hook('wh_all', ['*']),
    hook('wh_null', null),
    hook('wh_bounces', ['email.bounced', 'email.complained']),
  ];
});

describe('inbound.process', () => {
  it('sends one delivery per recipient to every hook subscribed to email.received or *', async () => {
    const boss = makeBoss();
    const outcome = await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss) });

    expect(outcome).toBe('processed');
    expect(boss.sends.map((s) => s.data.webhookId).sort()).toEqual(
      ['wh_all', 'wh_all', 'wh_null', 'wh_null', 'wh_received', 'wh_received'].sort(),
    );
    expect(boss.sends.every((s) => s.name === WEBHOOK_DELIVER_INBOUND_QUEUE)).toBe(true);
    expect(boss.sends.every((s) => JSON.stringify(s.options) === '{"retryLimit":5,"retryDelay":1,"retryBackoff":true}')).toBe(true);

    // Same payload (same delivery id) to every hook, a new id per recipient.
    const ids = new Set(boss.sends.map((s) => (s.data.payload as { id: string }).id));
    expect(ids.size).toBe(2);
  });

  it('builds the payload exactly as the contract says', async () => {
    const boss = makeBoss();
    state.hooks = [hook('wh_received', ['email.received'])];
    await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss) });

    const job = boss.sends[0]!.data;
    expect(Object.keys(job)).toEqual(['webhookId', 'url', 'signingSecret', 'eventType', 'payload']);
    expect(job.eventType).toBe('email.received');
    const payload = job.payload as Record<string, unknown>;
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify({ ...payload, id: 'ID' })).toBe(
      JSON.stringify({
        id: 'ID',
        type: 'email.received',
        organization_id: 'app_klara',
        email_id: 'ie_1',
        occurred_at: '2026-11-09T10:00:00.000Z',
        data: {
          recipient: SAMPLE.recipient,
          from: SAMPLE.from,
          subject: SAMPLE.subject,
          text: SAMPLE.body,
          message_id: SAMPLE.messageId,
          in_reply_to: SAMPLE.inReplyTo,
          references: [SAMPLE.inReplyTo],
          verdicts: { spf: 'PASS', dkim: 'FAIL', spam: 'PASS', virus: 'PASS' },
          from_authenticated: false,
          authentication: {
            from_domain: 'example.com',
            dkim_pass_domains: [],
            dkim_aligned: false,
            spf_domain: null,
            spf_aligned: false,
            dmarc_pass: false,
            ses_header_trusted: false,
            single_from: true,
          },
          auto: { auto_submitted: null, precedence: null, auto_response_suppress: null, is_auto: false },
        },
      }),
    );
  });

  it('delivers auto last, after authentication, with the auto-reply header values', async () => {
    const boss = makeBoss();
    state.hooks = [hook('wh_received', ['email.received'])];
    const raw = receivedMail({
      prepended: [],
      senderHeaders: ['Auto-Submitted: Auto-Replied (Vacation)', 'Precedence: bulk'],
    });

    await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss, raw) });

    const data = (boss.sends[0]!.data.payload as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual([
      'recipient', 'from', 'subject', 'text', 'message_id', 'in_reply_to', 'references', 'verdicts',
      'from_authenticated', 'authentication', 'auto',
    ]);
    expect(JSON.stringify(data.auto)).toBe(
      '{"auto_submitted":"auto-replied (vacation)","precedence":"bulk","auto_response_suppress":null,"is_auto":true}',
    );
  });

  it('delivers from_authenticated and authentication worked out from the SES header and the row verdicts', async () => {
    const boss = makeBoss();
    state.hooks = [hook('wh_received', ['email.received'])];
    const raw = receivedMail({
      prepended: sesPrependedHeaders({
        results: [
          'spf=pass (spfCheck: designates) client-ip=192.0.2.8; envelope-from=bounce@example.net; helo=mx.example.net',
          'dkim=pass header.i=@mail.example.com',
          'dmarc=pass header.from=example.com',
        ],
      }),
    });
    const row = { ...ROW, verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'GRAY' } };

    await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss, raw, [], row) });

    const data = (boss.sends[0]!.data.payload as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual([
      'recipient', 'from', 'subject', 'text', 'message_id', 'in_reply_to', 'references', 'verdicts',
      'from_authenticated', 'authentication', 'auto',
    ]);
    expect(JSON.stringify(data.verdicts)).toBe('{"spf":"PASS","dkim":"PASS","spam":"PASS","virus":"PASS","dmarc":"GRAY"}');
    expect(data.from_authenticated).toBe(true);
    expect(JSON.stringify(data.authentication)).toBe(
      JSON.stringify({
        from_domain: 'example.com',
        dkim_pass_domains: ['mail.example.com'],
        dkim_aligned: true,
        spf_domain: 'example.net',
        spf_aligned: false,
        dmarc_pass: false,
        ses_header_trusted: true,
        single_from: true,
      }),
    );
  });

  it('a row from before the dmarc verdict still gets the DKIM branch, and a spoof stays false', async () => {
    state.hooks = [hook('wh_received', ['email.received'])];
    const results = (dkimDomain: string) => [`dkim=pass header.d=${dkimDomain}`];
    const legacyRow = { ...ROW, verdicts: { spf: 'FAIL', dkim: 'PASS', spam: 'PASS', virus: 'PASS' } };
    const outcomes: unknown[] = [];
    for (const dkimDomain of ['example.com', 'example.net']) {
      const boss = makeBoss();
      const raw = receivedMail({ prepended: sesPrependedHeaders({ results: results(dkimDomain) }) });
      await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss, raw, [], legacyRow) });
      outcomes.push((boss.sends[0]!.data.payload as { data: { from_authenticated: boolean } }).data.from_authenticated);
    }
    expect(outcomes).toEqual([true, false]);
  });

  it('takes the plain part of a multipart/alternative mail', async () => {
    const boss = makeBoss();
    state.hooks = [hook('wh_received', ['email.received'])];
    await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: deps(boss, alternativeMail({ text: 'plain reply', html: '<p>html reply</p>' })),
    });
    expect(((boss.sends[0]!.data.payload as { data: { text: string } }).data).text).toBe('plain reply');
  });

  it('sends nothing when no hook takes email.received', async () => {
    const boss = makeBoss();
    state.hooks = [hook('wh_bounces', ['email.bounced'])];
    expect(await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_klara' }, deps: deps(boss) })).toBe('processed');
    expect(boss.sends).toEqual([]);
  });

  it('drops a job for another app or a deleted row', async () => {
    const boss = makeBoss();
    expect(await handleInboundProcess({ data: { inboundEmailId: 'ie_1', appId: 'app_other' }, deps: deps(boss) })).toBe('row_missing');
    expect(await handleInboundProcess({ data: { inboundEmailId: 'ie_x', appId: 'app_klara' }, deps: deps(boss) })).toBe('row_missing');
    expect(await handleInboundProcess({ data: { inboundEmailId: 'ie_1' }, deps: deps(boss) })).toBe('invalid_job');
    expect(boss.sends).toEqual([]);
  });

  it('drops the mail when the S3 object is gone (no retry)', async () => {
    const boss = makeBoss();
    const gone = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    const outcome = await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: { ...deps(boss), openObject: async () => Promise.reject(gone) },
    });
    expect(outcome).toBe('object_missing');
    expect(boss.sends).toEqual([]);
  });

  it('throws on any other S3 error so pg-boss retries, naming only the id', async () => {
    const boss = makeBoss();
    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(
      handleInboundProcess({
        data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
        deps: { ...deps(boss), openObject: async () => Promise.reject(denied) },
      }),
    ).rejects.toThrow('S3 fetch failed for inbound email ie_1 (AccessDenied)');
  });

  it('logs and sends nothing for unparseable MIME', async () => {
    const boss = makeBoss();
    const outcome = await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: { ...deps(boss), readMessage: async () => Promise.reject(new InboundMimeError('bad boundary')) },
    });
    expect(outcome).toBe('unparseable');
    expect(boss.sends).toEqual([]);
  });

  it('stores the keyed hash of the From address before the fan-out, scoped to the row and app', async () => {
    const boss = makeBoss();
    const hashes: StoredHash[] = [];
    const raw = plainMail(SAMPLE.body, { From: '"Jane Doe" <Jane.Doe@Example.COM>' });

    const outcome = await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: deps(boss, raw, hashes),
    });

    expect(outcome).toBe('processed');
    expect(hashes).toEqual([{ appId: 'app_klara', id: 'ie_1', senderHash: inboundSenderHash('jane.doe@example.com') }]);
    expect(hashes[0]!.senderHash).not.toContain('jane');
  });

  it('gives the same hash for the same sender in another case', async () => {
    const hashes: StoredHash[] = [];
    for (const from of ['JANE.DOE@EXAMPLE.COM', 'jane.doe@example.com']) {
      await handleInboundProcess({
        data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
        deps: deps(makeBoss(), plainMail(SAMPLE.body, { From: from }), hashes),
      });
    }
    expect(hashes).toHaveLength(2);
    expect(hashes[0]!.senderHash).toBe(hashes[1]!.senderHash);
  });

  it('stores no hash for a mail without a From address, and still delivers it', async () => {
    const boss = makeBoss();
    const hashes: StoredHash[] = [];

    const outcome = await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: deps(boss, plainMail(SAMPLE.body, { From: '' }), hashes),
    });

    expect(outcome).toBe('processed');
    expect(hashes).toEqual([]);
    expect(boss.sends.length).toBeGreaterThan(0);
  });

  it('sends nothing when the row is gone at the hash write (an erase ran meanwhile)', async () => {
    const boss = makeBoss();

    const outcome = await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: { ...deps(boss), storeSenderHash: async () => null },
    });

    expect(outcome).toBe('row_missing');
    expect(boss.sends).toEqual([]);
  });

  it('stores no hash for unparseable MIME', async () => {
    const hashes: StoredHash[] = [];
    await handleInboundProcess({
      data: { inboundEmailId: 'ie_1', appId: 'app_klara' },
      deps: { ...deps(makeBoss(), plainMail(), hashes), readMessage: async () => Promise.reject(new InboundMimeError('bad')) },
    });
    expect(hashes).toEqual([]);
  });
});
