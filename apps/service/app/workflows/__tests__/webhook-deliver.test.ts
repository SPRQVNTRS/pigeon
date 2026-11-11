/**
 * webhook-deliver — signature and header contract test.
 *
 * Verifies that `buildSignedHeaders` emits:
 *   - `Content-Type: application/json`
 *   - `Pigeon-Signature: t=<unix_ts>,v1=<hmac_sha256_hex>`
 *   - `Pigeon-Timestamp`, `Pigeon-Event` and `Pigeon-Delivery-Id` set from args
 * and that `verifyWebhookSignature` round-trips against the same body + secret,
 * and that a real delivery (fetch call) carries those headers and no
 * `X-Sprqvntrs-*` header.
 *
 * Wire names are written as literals on purpose: a renamed constant must not
 * be able to rename the contract silently.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// The delivery worker updates last_success/last_failure on the webhook row.
// That write is best-effort; stub the query chain so no database is needed.
vi.mock('#drizzle/db', () => ({
  db: { update: () => ({ set: () => ({ where: async () => undefined }) }) },
}));

import { buildSignedHeaders, verifyWebhookSignature, __test__ } from '../webhook-deliver';

const SECRET = 'secret_shh';
const TIMESTAMP = 1745139072;

function buildTestHeaders(rawBody: string): Record<string, string> {
  return buildSignedHeaders({
    signingSecret: SECRET,
    rawBody,
    eventType: 'email.bounced',
    deliveryId: 'evt_1',
    timestamp: TIMESTAMP,
  });
}

describe('webhook-deliver signature', () => {
  it('emits a Stripe-style Pigeon-Signature header', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'email.bounced' });
    const headers = buildTestHeaders(rawBody);

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Pigeon-Event']).toBe('email.bounced');
    expect(headers['Pigeon-Delivery-Id']).toBe('evt_1');
    expect(headers['Pigeon-Timestamp']).toBe(String(TIMESTAMP));

    const sig = headers['Pigeon-Signature'];
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const expectedHmac = createHmac('sha256', SECRET)
      .update(`${TIMESTAMP}.${rawBody}`)
      .digest('hex');
    expect(sig).toBe(`t=${TIMESTAMP},v1=${expectedHmac}`);

    // Round-trip verify
    expect(
      verifyWebhookSignature({
        signingSecret: SECRET,
        rawBody,
        header: sig!,
      }),
    ).toBe(true);

    // Wrong secret fails
    expect(
      verifyWebhookSignature({
        signingSecret: 'wrong',
        rawBody,
        header: sig!,
      }),
    ).toBe(false);
  });

  it('lets a receiver verify with the documented algorithm and only the new names', () => {
    const rawBody = JSON.stringify({ id: 'evt_9', type: 'email.sent' });
    const headers = buildTestHeaders(rawBody);

    // Receiver side, written from the contract in docs/webhooks.md.
    const signature = headers['Pigeon-Signature']!;
    const timestamp = headers['Pigeon-Timestamp']!;
    const parts = Object.fromEntries(signature.split(',').map((part) => part.split('=')));
    expect(parts.t).toBe(timestamp);
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(parts.v1).toBe(expected);
  });
});

describe('webhook-deliver request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends the Pigeon-* headers and no X-Sprqvntrs-* header on every delivery', async () => {
    // fetch sends only under allow; the default (deny) uses the pinned transport.
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'allow');
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const payload = { id: 'evt_77', type: 'email.bounced' };
    await __test__.handleWebhookDeliver([
      {
        data: {
          webhookId: 'wh_1',
          url: 'https://receiver.example.com/hook',
          signingSecret: SECRET,
          eventType: 'email.bounced',
          payload,
        },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = init.headers as Record<string, string>;
    const rawBody = init.body as string;

    expect(sent['Pigeon-Event']).toBe('email.bounced');
    expect(sent['Pigeon-Delivery-Id']).toBe('evt_77');
    expect(Object.keys(sent).filter((name) => name.toLowerCase().startsWith('x-sprqvntrs'))).toEqual([]);
    expect(sent['Pigeon-Signature']).toBe(
      `t=${sent['Pigeon-Timestamp']},v1=${createHmac('sha256', SECRET)
        .update(`${sent['Pigeon-Timestamp']}.${rawBody}`)
        .digest('hex')}`,
    );
  });
});
