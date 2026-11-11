# Webhook deliveries

Pigeon sends an HTTP POST to your webhook URL for each event you subscribed to.
This page is the contract a receiver can rely on.

## Request

- Method: `POST`, body: JSON, `Content-Type: application/json`.
- Body fields: `id`, `type`, `organization_id`, `email_id`, `occurred_at`, `data`.
- Any `2xx` answer counts as delivered. Any other answer, a network error or no
  answer within 15 seconds counts as a failure.
- A failed delivery is retried up to 5 times with growing delays. The same
  event can arrive more than once, so deduplicate on `Pigeon-Delivery-Id`.
- Unless the operator sets `PIGEON_WEBHOOK_PRIVATE_TARGETS=allow`, the URL must
  resolve to public addresses only, and a redirect is not followed: a `3xx`
  counts as a failure. The operator can let named hosts resolve to a private
  network address with `PIGEON_WEBHOOK_PRIVATE_HOSTS`. See [security.md](./security.md#webhook-targets-pigeon_webhook_private_targets).
- A delivery to a refused URL is not retried. It fails after one attempt.

## Headers

Use these names.

| Header | Value |
|--------|-------|
| `Pigeon-Signature` | `t=<unix_ts>,v1=<hmac_sha256_hex>` |
| `Pigeon-Timestamp` | The same `<unix_ts>` as `t` in the signature, in seconds |
| `Pigeon-Event` | The event type, for example `email.bounced` |
| `Pigeon-Delivery-Id` | The id of the delivery. It equals the `id` field of the body |

## Verify the signature

The key is the signing secret of the webhook. The algorithm is HMAC-SHA256.

1. Read `Pigeon-Signature`. Split it on `,` into `t=<unix_ts>` and `v1=<hex>`.
2. Build the signed string: `<unix_ts>` + `.` + the raw request body, exactly
   the bytes you received. Do not parse and re-encode the JSON first.
3. Compute `HMAC-SHA256(signing secret, signed string)` as lowercase hex.
4. Compare it with `v1` in constant time. Reject the request on a mismatch.
5. Reject the request when `t` is more than 5 minutes away from your clock.
   This limits replays.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function isValidPigeonSignature(opts: {
  signingSecret: string;
  rawBody: string;
  header: string; // the Pigeon-Signature value
}): boolean {
  const match = opts.header.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  if (!match) return false;
  const expected = createHmac('sha256', opts.signingSecret)
    .update(`${match[1]}.${opts.rawBody}`)
    .digest();
  const provided = Buffer.from(match[2]!, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```

## Rotating the secret

The signing secret is copied into each delivery when Pigeon queues it. A
delivery queued before a rotation, and its retries, stay signed with the old
secret. Deliveries queued after the rotation use the new one. During the
change, a receiver can try both secrets.
