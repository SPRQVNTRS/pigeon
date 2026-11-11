/**
 * Event types a webhook can subscribe to. Shared by the admin UI and the
 * Bearer admin API so the two surfaces cannot drift apart.
 */
export const SUPPORTED_WEBHOOK_EVENT_TYPES = [
  'email.sent',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.received',
  'contact.subscribed',
  'contact.unsubscribed',
] as const;

export type SupportedWebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENT_TYPES)[number];

export const WILDCARD_WEBHOOK_EVENT_TYPE = '*';

export type NormaliseEventTypesResult =
  | { ok: true; eventTypes: string[] }
  | { ok: false; message: string };

function isSupportedEventType(value: string): value is SupportedWebhookEventType {
  return (SUPPORTED_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Validate and dedupe a webhook event type list.
 *
 * Valid input is a non-empty list that is either exactly ['*'] or a subset of
 * SUPPORTED_WEBHOOK_EVENT_TYPES. '*' mixed with other values is rejected.
 */
export function normaliseEventTypes(raw: readonly string[]): NormaliseEventTypesResult {
  const eventTypes = [...new Set(raw)];

  if (eventTypes.length === 0) {
    return { ok: false, message: 'At least one event type is required' };
  }

  const hasWildcard = eventTypes.includes(WILDCARD_WEBHOOK_EVENT_TYPE);
  if (hasWildcard && eventTypes.length > 1) {
    return { ok: false, message: `'${WILDCARD_WEBHOOK_EVENT_TYPE}' cannot be combined with other event types` };
  }
  if (hasWildcard) return { ok: true, eventTypes };

  const unknown = eventTypes.filter((type) => !isSupportedEventType(type));
  if (unknown.length > 0) {
    return { ok: false, message: `Unsupported event types: ${unknown.join(', ')}` };
  }

  return { ok: true, eventTypes };
}
