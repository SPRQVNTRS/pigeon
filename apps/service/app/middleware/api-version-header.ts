import type { MiddlewareFunction } from 'react-router';
import { PIGEON_API_VERSION, PIGEON_API_VERSION_HEADER } from '#app/lib/api-version';

/**
 * Sets `Pigeon-Api-Version` on every response of the layout it wraps.
 * Put it first in the layout's middleware list, so it also covers the 401 and
 * 503 answers that the auth middleware returns without calling next().
 */
export const apiVersionHeaderMiddleware: MiddlewareFunction<Response> = async (_args, next) => {
  const response = await next();
  response.headers.set(PIGEON_API_VERSION_HEADER, String(PIGEON_API_VERSION));
  return response;
};
