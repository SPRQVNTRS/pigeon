/**
 * Every header name Pigeon writes on an outbound webhook delivery lives here,
 * and `buildWebhookHeaders` is the only place that assembles the set.
 *
 * Names: `Pigeon-Signature`, `Pigeon-Timestamp`, `Pigeon-Event`,
 * `Pigeon-Delivery-Id`. Receivers read these.
 * See `docs/adr/0001-public-release-naming.md`.
 */

export const WEBHOOK_CONTENT_TYPE_HEADER = 'Content-Type';

export const WEBHOOK_HEADERS = {
  /** Value: `t=<unix_ts>,v1=<hmac_sha256_hex>`. */
  signature: 'Pigeon-Signature',
  /** Value: the unix timestamp (seconds) that is also the `t=` part of the signature. */
  timestamp: 'Pigeon-Timestamp',
  eventType: 'Pigeon-Event',
  deliveryId: 'Pigeon-Delivery-Id',
} as const;

export interface WebhookHeaderValues {
  /** The full signature header value, `t=<unix_ts>,v1=<hmac_sha256_hex>`. */
  signature: string;
  /** Unix timestamp in seconds, the same number as `t` in `signature`. */
  timestamp: number;
  eventType: string;
  deliveryId: string;
}

/** Build the full header set for one outbound webhook request. */
export function buildWebhookHeaders(values: WebhookHeaderValues): Record<string, string> {
  return {
    [WEBHOOK_CONTENT_TYPE_HEADER]: 'application/json',
    [WEBHOOK_HEADERS.signature]: values.signature,
    [WEBHOOK_HEADERS.timestamp]: String(values.timestamp),
    [WEBHOOK_HEADERS.eventType]: values.eventType,
    [WEBHOOK_HEADERS.deliveryId]: values.deliveryId,
  };
}
