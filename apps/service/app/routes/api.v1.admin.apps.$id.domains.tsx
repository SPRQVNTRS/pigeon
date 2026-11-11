/**
 * GET /v1/admin/apps/:id/domains — list an app's sending domains
 *
 * Read only. Each domain has the same fields as an entry of the tenant route
 * GET /v1/domains, so a client can treat both sources alike. The fields are
 * picked one by one: a new column stays private until someone adds it here.
 *
 * Every response carries Cache-Control: no-store. A 200 carries
 * Pigeon-State-Version, read before the list (docs/concurrency.md).
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.domains';
import { getAppById } from '#app/models/apps.server';
import { listDomains } from '#app/services/domain-service';
import { apiError, noStoreJson } from '#app/lib/webhook-api';
import { withStateVersion } from '#app/lib/state-version';
import type { SelectDomain } from '#drizzle/schema';

function toPublicDomain(domain: SelectDomain) {
  return {
    id: domain.id,
    appId: domain.appId,
    name: domain.name,
    region: domain.region,
    dkimSelector: domain.dkimSelector,
    dkimTokens: domain.dkimTokens,
    spfStatus: domain.spfStatus,
    dkimStatus: domain.dkimStatus,
    dmarcStatus: domain.dmarcStatus,
    mxStatus: domain.mxStatus,
    verifiedAt: domain.verifiedAt,
    lastVerificationError: domain.lastVerificationError,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}

export async function loader({ params }: Route.LoaderArgs) {
  const app = await getAppById(params.id);
  if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

  const domains = await listDomains(params.id);
  // app.stateVersion was read before the list, so the list is never older than it.
  return withStateVersion(noStoreJson({ domains: domains.map(toPublicDomain) }), app.stateVersion);
}

export async function action() {
  return apiError({
    status: 405,
    code: 'method_not_allowed',
    message: 'Method Not Allowed',
    headers: { Allow: 'GET' },
  });
}
