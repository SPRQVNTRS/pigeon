/**
 * GET    /v1/audiences/:id — get an audience
 * PATCH  /v1/audiences/:id — update an audience
 * DELETE /v1/audiences/:id — delete an audience
 *
 * PATCH and DELETE take an optional If-Match (docs/concurrency.md) and answer
 * with the new Pigeon-State-Version.
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.audiences.$id';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { getAudience, updateAudience, deleteAudience } from '#app/models/audiences.server';
import { withConfigChange } from '#app/models/config-change.server';
import {
  ConfigItemNotFoundError,
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const UpdateAudienceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
});

function notFound(): Response {
  return Response.json({ error: { code: 'not_found', message: 'Audience not found' } }, { status: 404 });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  const audience = await getAudience(params.id, appId);
  if (!audience) return notFound();
  return Response.json({ audience });
}

/** Maps the errors a configuration write may throw. Anything else propagates. */
function configWriteError(err: unknown): Response {
  if (err instanceof ConfigItemNotFoundError) return notFound();
  if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
  throw err;
}

async function deleteAction(opts: { appId: string; audienceId: string; expectedVersion: number | null }): Promise<Response> {
  const { appId, audienceId, expectedVersion } = opts;
  try {
    const { stateVersion } = await withConfigChange({
      appId,
      expectedVersion,
      run: (tx) => deleteAudience(audienceId, appId, tx),
    });
    return withStateVersion(Response.json({ success: true }), stateVersion);
  } catch (err) {
    return configWriteError(err);
  }
}

async function patchAction(opts: {
  request: Request;
  appId: string;
  audienceId: string;
  expectedVersion: number | null;
}): Promise<Response> {
  const { request, appId, audienceId, expectedVersion } = opts;
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }
  const parsed = UpdateAudienceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }

  try {
    const { result: audience, stateVersion } = await withConfigChange({
      appId,
      expectedVersion,
      run: async (tx) => {
        const updated = await updateAudience(audienceId, appId, parsed.data, tx);
        if (!updated) throw new ConfigItemNotFoundError('Audience');
        return updated;
      },
    });
    return withStateVersion(Response.json({ audience }), stateVersion);
  } catch (err) {
    return configWriteError(err);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { appId } = context.get(apiKeyContext)!;
  if (request.method !== 'DELETE' && request.method !== 'PATCH') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
  }
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  const target = { appId, audienceId: params.id, expectedVersion: expected.expectedVersion };
  if (request.method === 'DELETE') return deleteAction(target);
  return patchAction({ request, ...target });
}
