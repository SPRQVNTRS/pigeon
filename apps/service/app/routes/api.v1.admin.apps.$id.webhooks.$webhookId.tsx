/**
 * PATCH /v1/admin/apps/:id/webhooks/:webhookId — replace the event types of
 * a webhook. Body: { eventTypes: string[] } (same rules as create). The
 * signing secret never changes here and is never returned.
 *
 * Takes an optional If-Match and answers with the new Pigeon-State-Version
 * (docs/concurrency.md).
 *
 * Every response carries Cache-Control: no-store.
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.webhooks.$webhookId';
import { z } from 'zod';
import { getAppById } from '#app/models/apps.server';
import { getWebhookById, updateWebhook } from '#app/models/webhooks.server';
import { webhookEventTypesSchema } from '#app/lib/webhook-input';
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

const log = createComponentLogger('AdminAppWebhookRoute');

const UpdateWebhookSchema = z.object({ eventTypes: webhookEventTypesSchema }).strict();

function methodNotAllowed(): Response {
  return apiError({
    status: 405,
    code: 'method_not_allowed',
    message: 'Method Not Allowed',
    headers: { Allow: 'PATCH' },
  });
}

export async function loader() {
  return methodNotAllowed();
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'PATCH') return methodNotAllowed();
  const expected = readExpectedVersion(request);
  if (expected.kind === 'invalid') return expected.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError({ status: 400, code: 'invalid_json', message: 'Invalid JSON body' });
  }

  const parsed = UpdateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return apiError({
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      extra: { issues: parsed.error.issues },
    });
  }

  const { id: appId, webhookId } = params;
  const { eventTypes } = parsed.data;

  try {
    const app = await getAppById(appId);
    if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

    const { result: webhook, stateVersion } = await withConfigChange({
      appId,
      expectedVersion: expected.expectedVersion,
      run: async (tx) => {
        const existing = await getWebhookById(webhookId, appId, tx);
        if (!existing) throw new ConfigItemNotFoundError('Webhook');
        return updateWebhook(webhookId, appId, { eventTypes }, tx);
      },
    });
    log.info('Webhook event types replaced via admin API', { appId, webhookId, eventTypes });
    return withStateVersion(noStoreJson({ webhook: toPublicWebhook(webhook) }), stateVersion);
  } catch (err) {
    if (err instanceof ConfigAppNotFoundError) {
      return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });
    }
    if (err instanceof ConfigItemNotFoundError) {
      return apiError({ status: 404, code: 'webhook_not_found', message: 'Webhook not found' });
    }
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to update webhook', { appId, webhookId, error });
    return apiError({ status: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
