/**
 * GET    /v1/admin/api-keys/:id — fetch one API key (metadata only, no plaintext)
 * DELETE /v1/admin/api-keys/:id — revoke an API key (sets revokedAt, returns updated record)
 *
 * DELETE uses revokeApiKeyById (admin-only, no appId scope check).
 * The tenant-scoped revokeApiKey(id, appId) is unaffected and still used by tenant routes.
 *
 * Key rows go out through toPublicApiKey, never with the key hash.
 *
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.api-keys.$id';
import { getApiKeyById, revokeApiKeyById } from '#app/models/api-keys.server';
import { createComponentLogger } from '#app/lib/logger';
import { toPublicApiKey } from '#app/lib/api-key-public';

const log = createComponentLogger('AdminApiKeysIdRoute');

export async function loader({ params }: Route.LoaderArgs) {
  const apiKey = await getApiKeyById(params.id);

  if (!apiKey) {
    return Response.json({ error: { code: 'not_found', message: 'API key not found' } }, { status: 404 });
  }

  return Response.json({ apiKey: toPublicApiKey(apiKey) });
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'DELETE') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method Not Allowed' } }, { status: 405 });
  }

  try {
    const apiKey = await revokeApiKeyById(params.id);
    log.info('API key revoked via admin API', { apiKeyId: params.id });
    return Response.json({ apiKey: toPublicApiKey(apiKey) });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error.message.includes('not found')) {
      return Response.json({ error: { code: 'not_found', message: 'API key not found' } }, { status: 404 });
    }

    log.error('Failed to revoke API key', { apiKeyId: params.id, error });
    return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
  }
}
