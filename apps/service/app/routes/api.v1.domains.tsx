/**
 * POST /v1/domains — create a domain identity
 * GET  /v1/domains — list domains for the current app
 *
 * Both answer with Pigeon-State-Version. POST takes an optional If-Match
 * (docs/concurrency.md): 412 on a stale version, 400 when malformed.
 */

import type { Route } from './+types/api.v1.domains';
import { z } from 'zod';
import { getOrchestrator } from '#app/services/workflows.server';
import { createDomain, listDomains } from '#app/services/domain-service';
import { createComponentLogger } from '#app/lib/logger';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { readStateVersion } from '#app/models/config-change.server';
import {
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const log = createComponentLogger('DomainsRoute');

const CreateDomainSchema = z.object({
  name: z.string().min(1).max(253),
  region: z.string().optional(),
});

export async function loader({ context }: Route.LoaderArgs) {
  const appId = context.get(apiKeyContext)!.appId;
  // The version is read before the list, so the list is never older than it.
  const stateVersion = await readStateVersion({ appId });
  if (stateVersion === null) throw new Error(`App ${appId} of an active API key does not exist`);
  const all = await listDomains(appId);

  return withStateVersion(Response.json({ domains: all }), stateVersion);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const appId = context.get(apiKeyContext)!.appId;
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = CreateDomainSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Validation error', issues: parsed.error.issues }, { status: 422 });
  }

  const { name, region } = parsed.data;

  try {
    const boss = getOrchestrator().getBoss();
    const { domain, dnsRecords, stateVersion } = await createDomain({
      appId,
      name,
      region,
      expectedVersion: expected.expectedVersion,
      boss,
    });

    log.info('Domain created via API', { domainId: domain.id, name });

    return withStateVersion(Response.json({ id: domain.id, domain, dnsRecords }, { status: 201 }), stateVersion);
  } catch (err) {
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to create domain', { error });
    return Response.json({ error: error.message }, { status: 500 });
  }
}
