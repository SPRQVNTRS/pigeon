/**
 * POST /v1/domains/:id/verify — manually re-enqueue a domain.verify job
 */

import type { Route } from './+types/api.v1.domains.$id.verify';
import { getDomain, enqueueVerification } from '#app/services/domain-service';
import { getOrchestrator } from '#app/services/workflows.server';
import { createComponentLogger } from '#app/lib/logger';
import { apiKeyContext } from '#app/middleware/api-key-context';

const log = createComponentLogger('DomainsVerifyRoute');

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  const appId = context.get(apiKeyContext)!.appId;
  const domain = await getDomain({ domainId: params.id, appId });

  if (!domain) {
    return Response.json({ error: 'Domain not found' }, { status: 404 });
  }

  try {
    const boss = getOrchestrator().getBoss();
    await enqueueVerification({ domainId: domain.id, boss });

    log.info('domain.verify job re-enqueued via API', { domainId: domain.id });
    return Response.json({ success: true, domainId: domain.id });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to enqueue verification', { error });
    return Response.json({ error: error.message }, { status: 500 });
  }
}
