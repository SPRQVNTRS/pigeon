/**
 * GET  /v1/admin/apps: list all apps
 * POST /v1/admin/apps: create a new app; a name another app has answers
 *                      409 { error: 'app_name_taken' }
 *
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps';
import { z } from 'zod';
import { createApp, listApps } from '#app/models/apps.server';
import { AppNameTakenError } from '#app/lib/app-name-taken';
import { createComponentLogger } from '#app/lib/logger';
import { withStateVersion } from '#app/lib/state-version';

const log = createComponentLogger('AdminAppsRoute');

const CreateAppSchema = z.object({
  name: z.string().min(1).max(255),
});

export async function loader(_args: Route.LoaderArgs) {
  const apps = await listApps();
  return Response.json({ apps });
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

  const parsed = CreateAppSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'validation_error', message: 'Validation failed', issues: parsed.error.issues } },
      { status: 422 },
    );
  }

  try {
    const app = await createApp({ name: parsed.data.name });
    log.info('App created via admin API', { appId: app.id, name: app.name });
    // A new app starts at state version 0: a manifest apply chains its writes from here.
    return withStateVersion(Response.json({ app }, { status: 201 }), app.stateVersion);
  } catch (err) {
    if (err instanceof AppNameTakenError) {
      log.info('App create refused, the name is taken', { name: err.appName });
      return Response.json({ error: 'app_name_taken' }, { status: 409 });
    }
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to create app', { error });
    return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
  }
}
