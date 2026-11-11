/**
 * POST /v1/audiences — create an audience
 * GET  /v1/audiences — list audiences for the current app
 *
 * Both answer with Pigeon-State-Version. POST takes an optional If-Match
 * (docs/concurrency.md): 412 on a stale version, 400 when malformed.
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.audiences';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { createAudience, listAudiences } from '#app/models/audiences.server';
import { readStateVersion, withConfigChange } from '#app/models/config-change.server';
import {
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const CreateAudienceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
});

export async function loader({ context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  // The version is read before the list, so the list is never older than it.
  const stateVersion = await readStateVersion({ appId });
  if (stateVersion === null) throw new Error(`App ${appId} of an active API key does not exist`);
  const audienceList = await listAudiences(appId);
  return withStateVersion(Response.json({ audiences: audienceList }), stateVersion);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
  }
  const { appId } = context.get(apiKeyContext)!;
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }
  const parsed = CreateAudienceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }

  try {
    const { result: audience, stateVersion } = await withConfigChange({
      appId,
      expectedVersion: expected.expectedVersion,
      run: (tx) => createAudience({ appId, ...parsed.data }, tx),
    });
    return withStateVersion(Response.json({ audience }, { status: 201 }), stateVersion);
  } catch (err) {
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    throw err;
  }
}
