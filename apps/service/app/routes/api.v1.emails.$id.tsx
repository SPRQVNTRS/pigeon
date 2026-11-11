/**
 * GET /v1/emails/:id — get an email by ID
 */
import type { Route } from './+types/api.v1.emails.$id';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { getEmail } from '#app/models/emails.server';

export async function loader({ params, context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  const email = await getEmail(params.id, appId);
  if (!email) {
    return Response.json({ error: { code: 'not_found', message: 'Email not found' } }, { status: 404 });
  }
  return Response.json({ email });
}
