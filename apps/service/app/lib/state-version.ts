/**
 * The state version of an app's configuration, at the HTTP edge.
 *
 * `apps.state_version` counts changes to an app's domains, audiences, webhooks
 * and inbound domains. Reads of that configuration report it in the
 * `Pigeon-State-Version` header. A write may send it back in `If-Match`: the
 * server then refuses the write with 412 when the app changed in between.
 * Without `If-Match` a write is unconditional, as before. See
 * docs/concurrency.md.
 *
 * Pure: no database import, so routes, models and tests can all use it.
 */

export const STATE_VERSION_HEADER = 'Pigeon-State-Version';

/** Postgres `integer` upper bound: the column cannot hold more. */
const MAX_STATE_VERSION = 2_147_483_647;
const VERSION_PATTERN = /^(?:"(\d{1,10})"|(\d{1,10}))$/;

/** The If-Match version did not match the app's current version. Nothing was changed. */
export class StateVersionMismatchError extends Error {
  readonly expected: number;
  readonly current: number;

  constructor(opts: { expected: number; current: number }) {
    super(`State version mismatch: expected ${opts.expected}, current ${opts.current}`);
    this.name = 'StateVersionMismatchError';
    this.expected = opts.expected;
    this.current = opts.current;
  }
}

/** The app of a configuration write does not exist. */
export class ConfigAppNotFoundError extends Error {
  readonly appId: string;

  constructor(appId: string) {
    super(`App ${appId} not found`);
    this.name = 'ConfigAppNotFoundError';
    this.appId = appId;
  }
}

/**
 * The item a configuration write targets does not exist (or belongs to
 * another app). Thrown inside the write, so the transaction rolls back and the
 * version is not bumped.
 */
export class ConfigItemNotFoundError extends Error {
  readonly item: string;

  constructor(item: string) {
    super(`${item} not found`);
    this.name = 'ConfigItemNotFoundError';
    this.item = item;
  }
}

export type IfMatch = { kind: 'absent' } | { kind: 'version'; version: number } | { kind: 'malformed' };

/**
 * Parses an If-Match header value. Accepts one integer, quoted (`"7"`, the
 * entity-tag form) or bare (`7`). Anything else, including `*`, a weak tag
 * and a list, is malformed.
 */
export function parseIfMatch(value: string | null): IfMatch {
  if (value === null) return { kind: 'absent' };
  const match = VERSION_PATTERN.exec(value.trim());
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) return { kind: 'malformed' };
  const version = Number(digits);
  if (version > MAX_STATE_VERSION) return { kind: 'malformed' };
  return { kind: 'version', version };
}

function jsonNoStore(body: unknown, init: { status: number; headers?: Record<string, string> }): Response {
  return Response.json(body, {
    status: init.status,
    headers: { ...init.headers, 'Cache-Control': 'no-store' },
  });
}

export function invalidIfMatchResponse(): Response {
  return jsonNoStore(
    {
      error: 'invalid_if_match',
      message: 'If-Match must hold one state version: an integer, quoted ("7") or bare (7)',
    },
    { status: 400 },
  );
}

export function stateVersionMismatchResponse(error: StateVersionMismatchError): Response {
  return jsonNoStore(
    { error: 'state_version_mismatch', expected: error.expected, current: error.current },
    { status: 412, headers: { [STATE_VERSION_HEADER]: String(error.current) } },
  );
}

export type ExpectedVersion =
  | { kind: 'ok'; expectedVersion: number | null }
  | { kind: 'invalid'; response: Response };

/** The version a write is conditional on: null without If-Match, a 400 response when malformed. */
export function readExpectedVersion(request: Request): ExpectedVersion {
  const ifMatch = parseIfMatch(request.headers.get('If-Match'));
  switch (ifMatch.kind) {
    case 'absent':
      return { kind: 'ok', expectedVersion: null };
    case 'version':
      return { kind: 'ok', expectedVersion: ifMatch.version };
    case 'malformed':
      return { kind: 'invalid', response: invalidIfMatchResponse() };
    default: {
      const unreachable: never = ifMatch;
      throw new Error(`Unknown If-Match kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Sets the header on a response and returns the same response. */
export function withStateVersion(response: Response, stateVersion: number): Response {
  response.headers.set(STATE_VERSION_HEADER, String(stateVersion));
  return response;
}
