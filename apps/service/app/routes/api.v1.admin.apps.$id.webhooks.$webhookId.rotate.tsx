/**
 * POST /v1/admin/apps/:id/webhooks/:webhookId/rotate — replace the signing
 * secret. The old secret stops working immediately; the new one is returned
 * once, in this response only.
 *
 * Takes an optional If-Match and answers with the new Pigeon-State-Version
 * (docs/concurrency.md). On a 412 the secret did not change.
 *
 * Every response carries Cache-Control: no-store.
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.webhooks.$webhookId.rotate';
import { getAppById } from '#app/models/apps.server';
import { generateSigningSecret, getWebhookById, updateWebhook } from '#app/models/webhooks.server';
import { apiError, noStoreJson, toPublicWebhook } from '#app/lib/webhook-api';
import { createComponentLogger } from '#app/lib/logger';
import { withConfigChange } from '#app/models/config-change.server';
import {
  ConfigAppNotFoundError,
  ConfigItemNotFoundError,
  StateVersionMismatchError,
  readExpectedVersion,
  stateVersionMismatchResponse,
  withStateVersion,
} from '#app/lib/state-version';

const log = createComponentLogger('AdminAppWebhookRotateRoute');

function methodNotAllowed(): Response {
  return apiError({
    status: 405,
    code: 'method_not_allowed',
    message: 'Method Not Allowed',
    headers: { Allow: 'POST' },
  });
}

export async function loader() {
  return methodNotAllowed();
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') return methodNotAllowed();

  const { id: appId, webhookId } = params;
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  try {
    const app = await getAppById(appId);
    if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

    const signingSecret = generateSigningSecret();
    const { result: webhook, stateVersion } = await withConfigChange({
      appId,
      expectedVersion: expected.expectedVersion,
      run: async (tx) => {
        const existing = await getWebhookById(webhookId, appId, tx);
        if (!existing) throw new ConfigItemNotFoundError('Webhook');
        return updateWebhook(webhookId, appId, { signingSecret }, tx);
      },
    });

    log.info('Webhook signing secret rotated via admin API', { appId, webhookId, url: webhook.url });
    return withStateVersion(noStoreJson({ webhook: toPublicWebhook(webhook), signingSecret }), stateVersion);
  } catch (err) {
    if (err instanceof ConfigAppNotFoundError) {
      return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });
    }
    if (err instanceof ConfigItemNotFoundError) {
      return apiError({ status: 404, code: 'webhook_not_found', message: 'Webhook not found' });
    }
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to rotate webhook secret', { appId, webhookId, error });
    return apiError({ status: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
