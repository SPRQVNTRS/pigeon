import type { Route } from './+types/admin.apps.$appId.keys.$keyId.revoke';
import { redirect } from 'react-router';
import { getUser } from '#app/middleware/helpers';
import { revokeApiKey } from '#app/models/api-keys.server';
import { sessionStorage } from '#app/services/session.server';

export const handle = { title: 'Revoke API Key' };

// GET: redirect to keys list (graceful direct navigation)
export async function loader({ params }: Route.LoaderArgs) {
  return redirect(`/admin/apps/${params.appId}/keys`);
}

// POST: revoke key and redirect back with flash confirmation
export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth guard

  await revokeApiKey(params.keyId, params.appId);

  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  session.set('revokedKey', true);

  return redirect(`/admin/apps/${params.appId}/keys`, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}
