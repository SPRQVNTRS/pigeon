import type { Route } from './+types/admin.apps.$appId.audiences.$audienceId';
import { redirect } from 'react-router';
import { getAudience } from '#app/models/audiences.server';
import { getUser } from '#app/middleware/helpers';

export const handle = { title: 'Audience' };

// Redirect /admin/apps/:appId/audiences/:audienceId → contacts list
export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const audience = await getAudience(params.audienceId, params.appId);
  if (!audience) {
    throw new Response('Not Found', { status: 404 });
  }
  void user; // consumed for auth
  return redirect(`/admin/apps/${params.appId}/audiences/${params.audienceId}/contacts`);
}
