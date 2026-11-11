/**
 * GET /v1/admin/apps/:id/audiences — list an app's audiences
 *
 * Read only. Each audience has the same fields as an entry of the tenant route
 * GET /v1/audiences, so a client can treat both sources alike. The fields are
 * picked one by one: a new column stays private until someone adds it here.
 *
 * Every response carries Cache-Control: no-store. A 200 carries
 * Pigeon-State-Version, read before the list (docs/concurrency.md).
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.audiences';
import { getAppById } from '#app/models/apps.server';
import { listAudiences, type Audience } from '#app/models/audiences.server';
import { apiError, noStoreJson } from '#app/lib/webhook-api';
import { withStateVersion } from '#app/lib/state-version';

function toPublicAudience(audience: Audience) {
  return {
    id: audience.id,
    appId: audience.appId,
    name: audience.name,
    description: audience.description,
    createdAt: audience.createdAt,
    updatedAt: audience.updatedAt,
  };
}

export async function loader({ params }: Route.LoaderArgs) {
  const app = await getAppById(params.id);
  if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

  const audiences = await listAudiences(params.id);
  // app.stateVersion was read before the list, so the list is never older than it.
  return withStateVersion(noStoreJson({ audiences: audiences.map(toPublicAudience) }), app.stateVersion);
}

export async function action() {
  return apiError({
    status: 405,
    code: 'method_not_allowed',
    message: 'Method Not Allowed',
    headers: { Allow: 'GET' },
  });
}
