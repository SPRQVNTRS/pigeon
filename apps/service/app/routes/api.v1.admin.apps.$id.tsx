/**
 * GET    /v1/admin/apps/:id — fetch one app
 * DELETE /v1/admin/apps/:id — delete an app (fails if dependents exist)
 *
 * GET answers with Pigeon-State-Version (docs/concurrency.md); the body's
 * app.stateVersion holds the same number.
 *
 * Protected by adminAuthMiddleware via _admin-api layout.
 *
 * DELETE is implemented here because app deletion requires checking for
 * dependent rows in api_keys, audiences, domains, and emails (no ON DELETE CASCADE
 * in schema). The deleteApp() model handles the dependency check and returns a
 * typed error with code 'has_dependents' (→ 409) or 'not_found' (→ 404).
 */

import type { Route } from './+types/api.v1.admin.apps.$id';
import { getAppById, deleteApp, AppDeleteError } from '#app/models/apps.server';
import { createComponentLogger } from '#app/lib/logger';
import { withStateVersion } from '#app/lib/state-version';

const log = createComponentLogger('AdminAppsIdRoute');

export async function loader({ params }: Route.LoaderArgs) {
  const app = await getAppById(params.id);

  if (!app) {
    return Response.json({ error: { code: 'not_found', message: 'App not found' } }, { status: 404 });
  }

  return withStateVersion(Response.json({ app }), app.stateVersion);
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'DELETE') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method Not Allowed' } }, { status: 405 });
  }

  try {
    await deleteApp(params.id);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof AppDeleteError) {
      if (err.code === 'not_found') {
        return Response.json({ error: { code: 'not_found', message: err.message } }, { status: 404 });
      }
      if (err.code === 'has_dependents') {
        return Response.json({ error: { code: 'has_dependents', message: err.message } }, { status: 409 });
      }
    }

    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to delete app', { appId: params.id, error });
    return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
  }
}
