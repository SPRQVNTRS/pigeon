/**
 * GET  /v1/admin/apps/:id/inbound-domains — list an app's inbound domains
 * POST /v1/admin/apps/:id/inbound-domains — add one: { name }
 *
 * The name is lower-cased and must be a hostname. A name that any app has
 * already answers 409 inbound_domain_exists. Adding a domain here only routes
 * mail that SES already receives for it: the SES identity, MX record and
 * receipt rule come from scripts/aws-inbound.ts.
 *
 * Every response carries Cache-Control: no-store. GET and a 201 carry
 * Pigeon-State-Version; POST takes an optional If-Match (docs/concurrency.md).
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.inbound-domains';
import { z } from 'zod';
import { getAppById } from '#app/models/apps.server';
import { createInboundDomain, listInboundDomains } from '#app/models/inbound-domains.server';
import { toPublicInboundDomain } from '#app/lib/inbound/public';
import { normaliseInboundDomainName } from '#app/lib/inbound/domain-name';
import { apiError, noStoreJson } from '#app/lib/webhook-api';
import { isUniqueViolation } from '#app/lib/pg-errors';
import { createComponentLogger } from '#app/lib/logger';
import { withConfigChange } from '#app/models/config-change.server';
import {
  ConfigAppNotFoundError,
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const log = createComponentLogger('AdminInboundDomainsRoute');

const CreateInboundDomainSchema = z.object({
  name: z.string().transform((raw, ctx) => {
    const result = normaliseInboundDomainName(raw);
    if (result.ok) return result.name;
    ctx.addIssue({ code: 'custom', message: result.message });
    return z.NEVER;
  }),
});

function appNotFound(): Response {
  return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });
}

export async function loader({ params }: Route.LoaderArgs) {
  const app = await getAppById(params.id);
  if (!app) return appNotFound();

  // app.stateVersion was read before the list, so the list is never older than it.
  const domains = await listInboundDomains({ appId: params.id });
  return withStateVersion(noStoreJson({ inboundDomains: domains.map(toPublicInboundDomain) }), app.stateVersion);
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return apiError({
      status: 405,
      code: 'method_not_allowed',
      message: 'Method Not Allowed',
      headers: { Allow: 'GET, POST' },
    });
  }

  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid_json', message: 'Invalid JSON body' });
  }

  const parsed = CreateInboundDomainSchema.safeParse(body);
  if (!parsed.success) {
    return apiError({
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      extra: { issues: parsed.error.issues },
    });
  }

  const appId = params.id;
  const { name } = parsed.data;

  try {
    const app = await getAppById(appId);
    if (!app) return appNotFound();

    const { result: domain, stateVersion } = await withConfigChange({
      appId,
      expectedVersion: expected.expectedVersion,
      run: (tx) => createInboundDomain({ appId, name, db: tx }),
    });
    log.info('Inbound domain added via admin API', { appId, inboundDomainId: domain.id, domain: name });
    return withStateVersion(
      noStoreJson({ inboundDomain: toPublicInboundDomain(domain) }, { status: 201 }),
      stateVersion,
    );
  } catch (err) {
    if (err instanceof ConfigAppNotFoundError) return appNotFound();
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    if (isUniqueViolation(err)) {
      return apiError({
        status: 409,
        code: 'inbound_domain_exists',
        message: 'This inbound domain is already registered',
      });
    }
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to add inbound domain', { appId, error });
    return apiError({ status: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
