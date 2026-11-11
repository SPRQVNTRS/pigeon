/**
 * GET /v1/admin/apps/:id/inbound-emails?limit=50 — the app's received mails,
 * newest first: ids, times and recipient counts only. Never an address, a
 * subject or a body. Rows exist for under 7 days (inbound-retention).
 *
 * Every response carries Cache-Control: no-store.
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.inbound-emails';
import { getAppById } from '#app/models/apps.server';
import { listInboundEmails } from '#app/models/inbound-emails.server';
import { apiError, noStoreJson } from '#app/lib/webhook-api';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function readLimit(url: URL): number | null {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return limit;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const limit = readLimit(new URL(request.url));
  if (limit === null) {
    return apiError({
      status: 422,
      code: 'validation_error',
      message: `limit must be an integer from 1 to ${MAX_LIMIT}`,
    });
  }

  const app = await getAppById(params.id);
  if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

  const inboundEmails = await listInboundEmails({ appId: params.id, limit });
  return noStoreJson({ inboundEmails });
}
