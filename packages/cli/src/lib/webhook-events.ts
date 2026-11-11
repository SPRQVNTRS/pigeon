export const WEBHOOK_EVENT_TYPES = [
  'email.sent',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
  'email.received',
  'contact.subscribed',
  'contact.unsubscribed',
] as const;

export const ALL_EVENTS = '*';

const KNOWN_EVENTS: ReadonlySet<string> = new Set([...WEBHOOK_EVENT_TYPES, ALL_EVENTS]);

/**
 * Parses a comma separated `--events` value. Trims, drops empty items and
 * duplicates, and rejects unknown types. Runs before any API call.
 */
export function parseEventTypes(raw: string): string[] {
  const events = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ];
  if (events.length === 0) {
    throw new Error(`--events needs at least one event type. Use ${[...KNOWN_EVENTS].join(', ')}.`);
  }

  const unknown = events.filter((event) => !KNOWN_EVENTS.has(event));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown event type: ${unknown.join(', ')}. Use ${[...KNOWN_EVENTS].join(', ')}.`,
    );
  }

  if (events.length > 1 && events.includes(ALL_EVENTS)) {
    throw new Error(`Use ${ALL_EVENTS} alone. It already covers every event type.`);
  }
  return events;
}
