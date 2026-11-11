/**
 * Every header name Pigeon writes on an outbound webhook delivery lives here,
 * and `buildWebhookHeaders` is the only place that assembles the set.
 *
 * Public names: `Pigeon-Signature`, `Pigeon-Timestamp`, `Pigeon-Event`,
 * `Pigeon-Delivery-Id`. Receivers read these.
 *
 * Until the public release the service also sends the deprecated
 * `X-Sprqvntrs-*` names with identical values (see the marked LEGACY section
 * at the end). Removing that one section stops the legacy headers.
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

type HeaderSetBuilder = (values: WebhookHeaderValues) => Record<string, string>;

function buildCurrentHeaders(values: WebhookHeaderValues): Record<string, string> {
  return {
    [WEBHOOK_HEADERS.signature]: values.signature,
    [WEBHOOK_HEADERS.timestamp]: String(values.timestamp),
    [WEBHOOK_HEADERS.eventType]: values.eventType,
    [WEBHOOK_HEADERS.deliveryId]: values.deliveryId,
  };
}

/** The header sets sent on every delivery. The LEGACY section below adds one. */
const headerSetBuilders: HeaderSetBuilder[] = [buildCurrentHeaders];

/** Build the full header set for one outbound webhook request. */
export function buildWebhookHeaders(values: WebhookHeaderValues): Record<string, string> {
  const headers: Record<string, string> = { [WEBHOOK_CONTENT_TYPE_HEADER]: 'application/json' };
  for (const buildHeaderSet of headerSetBuilders) {
    Object.assign(headers, buildHeaderSet(values));
  }
  return headers;
}

// ===== LEGACY X-Sprqvntrs-* HEADERS: BEGIN =====================================
// Deprecated. Sent next to the Pigeon-* names until the public release, then
// removed as a counted API version bump (PIGEON_API_VERSION). To remove them,
// delete everything from this line to the END marker. Nothing else changes.
// There is no legacy twin of Pigeon-Timestamp: it is new.

export const LEGACY_WEBHOOK_HEADERS = {
  signature: 'X-Sprqvntrs-Signature',
  eventType: 'X-Sprqvntrs-Event',
  deliveryId: 'X-Sprqvntrs-Delivery-Id',
} as const;

function buildLegacyHeaders(values: WebhookHeaderValues): Record<string, string> {
  return {
    [LEGACY_WEBHOOK_HEADERS.signature]: values.signature,
    [LEGACY_WEBHOOK_HEADERS.eventType]: values.eventType,
    [LEGACY_WEBHOOK_HEADERS.deliveryId]: values.deliveryId,
  };
}

headerSetBuilders.push(buildLegacyHeaders);

// ===== LEGACY X-Sprqvntrs-* HEADERS: END =======================================
