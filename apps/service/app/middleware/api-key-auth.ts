import type { MiddlewareFunction } from 'react-router';
import { verifyApiKey, touchLastUsed } from '../models/api-keys.server';
import { apiKeyContext } from './api-key-context';
import { createTokenBucketLimiter, type RateLimiter } from '#app/lib/rate-limit';
import { resolveRateLimitMode, type RateLimitMode } from '#app/config/deployment-settings';

function unauthorized(): Response {
  return Response.json(
    { error: { code: 'unauthorized', message: 'Invalid or missing API key' } },
    { status: 401 },
  );
}

/** A real Response, not data(): data() would drop Retry-After without a route `headers` export. */
function rateLimited(retryAfterSeconds: number): Response {
  return Response.json(
    { error: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * API key authentication middleware for /v1/* routes.
 * Extracts `Authorization: Bearer <token>`, verifies it, applies the key's
 * rate limit and sets apiKeyContext.
 *
 * Rate limit: `api_keys.rate_limit_per_second`, one token bucket per key
 * (app/lib/rate-limit.ts). NULL means unlimited. Over the limit the answer is
 * 429 `{ error: 'rate_limited' }` with Retry-After, before any route code
 * runs. PIGEON_RATE_LIMIT=off turns the check off; while the variable is
 * unset the mode is `enforce` (see app/config/deployment-settings.ts).
 */
export function createApiKeyAuthMiddleware(deps: {
  limiter: RateLimiter;
  resolveMode?: () => RateLimitMode;
}): MiddlewareFunction<Response> {
  const resolveMode = deps.resolveMode ?? resolveRateLimitMode;

  return async ({ request, context }, next) => {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return unauthorized();

    const record = await verifyApiKey(token);
    if (!record) return unauthorized();

    const ratePerSecond = record.rateLimitPerSecond;
    if (ratePerSecond !== null && resolveMode() === 'enforce') {
      const decision = deps.limiter.take({ key: record.id, ratePerSecond });
      if (!decision.isAllowed) return rateLimited(decision.retryAfterSeconds);
    }

    // Fire-and-forget, so it does not block the hot path
    void touchLastUsed(record.id);

    context.set(apiKeyContext, {
      apiKeyId: record.id,
      appId: record.appId,
      rateLimitPerSecond: ratePerSecond,
    });

    return next();
  };
}

export const apiKeyAuthMiddleware = createApiKeyAuthMiddleware({ limiter: createTokenBucketLimiter() });
