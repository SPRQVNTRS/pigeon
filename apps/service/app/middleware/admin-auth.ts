import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareFunction } from 'react-router';
import { adminContext } from './admin-context';

/**
 * Admin auth middleware for /v1/admin/* routes.
 *
 * Validates a static Bearer token against the ADMIN_SECRET env var. (In the
 * Bay vault the entry is PIGEON_ADMIN_SECRET; the deploy framework strips
 * the service-name prefix when injecting into the container, matching the
 * SESSION_SECRET / AWS_ACCESS_KEY_ID convention.)
 *
 * Error responses:
 *   503 — ADMIN_SECRET not configured (prevents silent open access)
 *   401 — missing or invalid Bearer token
 */
export const adminAuthMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    return Response.json(
      { error: { code: 'not_configured', message: 'Admin API not configured' } },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Invalid or missing admin secret' } },
      { status: 401 },
    );
  }

  const secretBuf = Buffer.from(secret, 'utf8');
  const tokenBuf = Buffer.from(token, 'utf8');

  // timingSafeEqual throws if buffers differ in byte length — guard first
  const isValid =
    Buffer.byteLength(secretBuf) === Buffer.byteLength(tokenBuf) &&
    timingSafeEqual(secretBuf, tokenBuf);

  if (!isValid) {
    return Response.json(
      { error: { code: 'unauthorized', message: 'Invalid or missing admin secret' } },
      { status: 401 },
    );
  }

  context.set(adminContext, true);

  return next();
};
