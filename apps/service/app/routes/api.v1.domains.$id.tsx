/**
 * GET    /v1/domains/:id — get a domain
 * DELETE /v1/domains/:id — delete a domain
 *
 * DELETE takes an optional If-Match (docs/concurrency.md) and answers with the
 * new Pigeon-State-Version.
 */

import type { Route } from './+types/api.v1.domains.$id';
import { getDomain, deleteDomain } from '#app/services/domain-service';
import { buildDnsRecords } from '#app/lib/ses';
import { CONFIG } from '#config';
import { createComponentLogger } from '#app/lib/logger';
import { apiKeyContext } from '#app/middleware/api-key-context';
import {
  ConfigItemNotFoundError,
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const log = createComponentLogger('DomainsIdRoute');

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const appId = context.get(apiKeyContext)!.appId;
  const domain = await getDomain({ domainId: params.id, appId });

  if (!domain) {
    return Response.json({ error: 'Domain not found' }, { status: 404 });
  }

  const dnsRecords = buildDnsRecords({
    domain: domain.name,
    region: domain.region ?? CONFIG.aws.region,
    dkimTokens: domain.dkimTokens ?? [],
  });

  return Response.json({ domain, dnsRecords });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'DELETE') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const appId = context.get(apiKeyContext)!.appId;
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  try {
    const { stateVersion } = await deleteDomain({
      domainId: params.id,
      appId,
      expectedVersion: expected.expectedVersion,
    });

    log.info('Domain deleted via API', { domainId: params.id });
    return withStateVersion(Response.json({ success: true }), stateVersion);
  } catch (err) {
    if (err instanceof ConfigItemNotFoundError) {
      return Response.json({ error: 'Domain not found' }, { status: 404 });
    }
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to delete domain', { error });
    return Response.json({ error: error.message }, { status: 500 });
  }
}
