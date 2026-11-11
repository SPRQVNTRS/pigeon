/**
 * GET  /v1/admin/api-keys?appId=<id> — list API keys (all, or filtered by appId)
 * POST /v1/admin/api-keys            — create a new API key for a given app
 *
 * POST validates that the given appId references an existing app before
 * inserting — prevents orphaned keys against a non-existent app.
 *
 * Key rows go out through toPublicApiKey, never with the key hash.
 *
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.api-keys';
import { z } from 'zod';
import { createApiKey, listAllApiKeys } from '#app/models/api-keys.server';
import { getAppById } from '#app/models/apps.server';
import { toPublicApiKey } from '#app/lib/api-key-public';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('AdminApiKeysRoute');

const CreateApiKeySchema = z.object({
  appId: z.string().min(1),
  name: z.string().min(1).max(255),
});

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const appId = url.searchParams.get('appId') ?? undefined;

  const keys = await listAllApiKeys(appId);
  return Response.json({ apiKeys: keys.map(toPublicApiKey) });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method Not Allowed' } }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'Invalid JSON body' } }, { status: 400 });
  }

  const parsed = CreateApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'validation_error', message: 'Validation failed', issues: parsed.error.issues } },
      { status: 422 },
    );
  }

  const { appId, name } = parsed.data;

  const app = await getAppById(appId);
  if (!app) {
    return Response.json(
      { error: { code: 'invalid_app_id', message: 'App not found' } },
      { status: 422 },
    );
  }

  try {
    const { plaintext, record } = await createApiKey({ appId, name });
    log.info('API key created via admin API', { apiKeyId: record.id, appId, name });
    return Response.json({ apiKey: toPublicApiKey(record), plaintext }, { status: 201 });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to create API key', { error });
    return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
  }
}
