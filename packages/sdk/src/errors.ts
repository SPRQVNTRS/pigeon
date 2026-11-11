/**
 * SDK error types.
 *
 * Single class with a `code` discriminator — consumers switch on `err.code`.
 * Codes mirror what `apps/service/app/routes/api.v1.*` returns in the
 * `{ error: { code, message, details? } }` envelope, plus a small set of
 * client-side-only codes (`network_error`, `timeout`, `unknown`).
 */

export type ErrorCode =
  // Server envelope codes (see apps/service/app/routes/api.v1.*.tsx and
  // apps/service/app/middleware/api-key-auth.ts)
  | 'unauthorized'
  | 'invalid_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'domain_not_verified'
  | 'idempotency_key_collision'
  | 'rate_limited'
  | 'server_error'
  // Client-side-only codes
  | 'network_error'
  | 'timeout'
  | 'unknown';

export interface PigeonErrorOptions {
  code: ErrorCode;
  message: string;
  status: number;
  details?: unknown;
  requestId?: string;
  cause?: unknown;
}

export class PigeonError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(opts: PigeonErrorOptions) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'PigeonError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.requestId = opts.requestId;
  }
}

/**
 * Parse a service error response body into a {@link PigeonError}.
 *
 * The service uses two shapes:
 *   - `{ error: { code, message, details? } }` (most routes, spec 05)
 *   - `{ error: "string" }` (some domains routes) — we map these to a sensible
 *     code based on HTTP status.
 */
export function parseServiceError(
  status: number,
  body: unknown,
  requestId?: string,
): PigeonError {
  const fallbackCode = codeForStatus(status);

  if (body && typeof body === 'object') {
    const errorField = (body as { error?: unknown }).error;

    if (errorField && typeof errorField === 'object') {
      const obj = errorField as { code?: unknown; message?: unknown; details?: unknown };
      const code = typeof obj.code === 'string' ? (obj.code as ErrorCode) : fallbackCode;
      const message =
        typeof obj.message === 'string' && obj.message.length > 0
          ? obj.message
          : `HTTP ${status}`;
      return new PigeonError({
        code,
        message,
        status,
        details: obj.details,
        requestId,
      });
    }

    if (typeof errorField === 'string') {
      return new PigeonError({
        code: fallbackCode,
        message: errorField,
        status,
        requestId,
      });
    }
  }

  return new PigeonError({
    code: fallbackCode,
    message: `HTTP ${status}`,
    status,
    details: body,
    requestId,
  });
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'idempotency_key_collision';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}
