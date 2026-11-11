import { describe, it, expect } from 'vitest';
import { parseServiceError, PigeonError } from '../../src/errors';

describe('parseServiceError', () => {
  it('parses the rich envelope: { error: { code, message, details } }', () => {
    const err = parseServiceError(400, {
      error: {
        code: 'invalid_request',
        message: 'Validation error',
        details: { to: ['Required'] },
      },
    });

    expect(err).toBeInstanceOf(PigeonError);
    expect(err.code).toBe('invalid_request');
    expect(err.status).toBe(400);
    expect(err.message).toBe('Validation error');
    expect(err.details).toEqual({ to: ['Required'] });
  });

  it('falls back to status-derived code when body has no envelope', () => {
    const err = parseServiceError(404, null);
    expect(err.code).toBe('not_found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('HTTP 404');
  });

  it('handles the string envelope: { error: "something" }', () => {
    // `/v1/domains` uses this shape for some errors (see api.v1.domains.tsx).
    const err = parseServiceError(500, { error: 'boom' });
    expect(err.code).toBe('server_error');
    expect(err.message).toBe('boom');
  });

  it('carries through request id', () => {
    const err = parseServiceError(
      429,
      { error: { code: 'rate_limited', message: 'slow down' } },
      'req_abc',
    );
    expect(err.requestId).toBe('req_abc');
    expect(err.code).toBe('rate_limited');
  });

  it('maps common HTTP statuses to stable codes', () => {
    expect(parseServiceError(401, null).code).toBe('unauthorized');
    expect(parseServiceError(403, null).code).toBe('unauthorized');
    expect(parseServiceError(405, null).code).toBe('method_not_allowed');
    expect(parseServiceError(409, null).code).toBe('idempotency_key_collision');
    expect(parseServiceError(422, null).code).toBe('invalid_request');
    expect(parseServiceError(502, null).code).toBe('server_error');
  });

  it('preserves unknown server-supplied error codes (forward compat)', () => {
    const err = parseServiceError(418, {
      error: { code: 'teapot', message: 'short and stout' },
    });
    // Codes are a branded `ErrorCode` union; we want forward-compat when the
    // service adds a new code before the SDK is updated.
    expect(err.code).toBe('teapot');
    expect(err.message).toBe('short and stout');
  });
});
