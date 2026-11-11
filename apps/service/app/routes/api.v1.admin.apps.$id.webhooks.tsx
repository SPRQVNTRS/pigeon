/**
 * GET  /v1/admin/apps/:id/webhooks — list an app's webhooks (never the signing secret)
 * POST /v1/admin/apps/:id/webhooks — create a webhook; the signing secret is
 *                                    returned once, in the 201 response only
 *
 * Body for POST: { url: string, eventTypes: string[] }. The URL is normalised
 * (see lib/webhook-url.ts) and a webhook with the same normalised URL for the
 * app answers 409 webhook_exists. Under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny a
 * host that resolves to a non-public address answers 422 (lib/webhook-target.ts).
 *
 * Every response carries Cache-Control: no-store. GET and a 201 carry
 * Pigeon-State-Version; POST takes an optional If-Match (docs/concurrency.md).
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.webhooks';
import { z } from 'zod';
import { getAppById } from '#app/models/apps.server';
import {
  createWebhook,
  generateSigningSecret,
  getWebhookByAppAndUrl,
  listWebhooks,
} from '#app/models/webhooks.server';
import { webhookEventTypesSchema, webhookUrlSchema } from '#app/lib/webhook-input';
import { checkRegistrableWebhookUrl } from '#app/lib/webhook-target';
import { apiError, noStoreJson, toPublicWebhook } from '#app/lib/webhook-api';
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

const log = createComponentLogger('AdminAppWebhooksRoute');

const CreateWebhookSchema = z.object({
  url: webhookUrlSchema,
  eventTypes: webhookEventTypesSchema,
});

function appNotFound(): Response {
  return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });
}

/** Thrown inside the transaction, so the version is not bumped. */
class WebhookExistsError extends Error {
  readonly webhookId: string;

  constructor(webhookId: string) {
    super('A webhook with this URL already exists for the app');
    this.name = 'WebhookExistsError';
    this.webhookId = webhookId;
  }
}

function webhookExists(webhookId: string | null): Response {
  return apiError({
    status: 409,
    code: 'webhook_exists',
    message: 'A webhook with this URL already exists for the app',
    extra: { webhookId },
  });
}

export async function loader({ params }: Route.LoaderArgs) {
  const app = await getAppById(params.id);
  if (!app) return appNotFound();

  // app.stateVersion was read before the list, so the list is never older than it.
  const webhooks = await listWebhooks(params.id);
  return withStateVersion(noStoreJson({ webhooks: webhooks.map(toPublicWebhook) }), app.stateVersion);
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

  const parsed = CreateWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return apiError({
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      extra: { issues: parsed.error.issues },
    });
  }

  const appId = params.id;
  const { url, eventTypes } = parsed.data;

  // Under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny the host must resolve to public addresses only.
  const target = await checkRegistrableWebhookUrl(url);
  if (!target.ok) {
    return apiError({
      status: 422,
      code: 'validation_error',
      message: 'Validation failed',
      extra: { issues: [{ code: 'custom', path: ['url'], message: target.reason }] },
    });
  }

  try {
    const app = await getAppById(appId);
    if (!app) return appNotFound();

    const signingSecret = generateSigningSecret();
    // The duplicate check runs inside the transaction, after the app row lock,
    // so two creates of one URL are serialized and the second sees the first.
    const { result: webhook, stateVersion } = await withConfigChange({
      appId,
      expectedVersion: expected.expectedVersion,
      run: async (tx) => {
        const existing = await getWebhookByAppAndUrl(appId, url, tx);
        if (existing) throw new WebhookExistsError(existing.id);
        return createWebhook({ appId, url, signingSecret, eventTypes }, tx);
      },
    });

    log.info('Webhook created via admin API', { appId, webhookId: webhook.id, url });
    return withStateVersion(
      noStoreJson({ webhook: toPublicWebhook(webhook), signingSecret }, { status: 201 }),
      stateVersion,
    );
  } catch (err) {
    if (err instanceof ConfigAppNotFoundError) return appNotFound();
    if (err instanceof StateVersionMismatchError) return stateVersionMismatchResponse(err);
    if (err instanceof WebhookExistsError) return webhookExists(err.webhookId);
    if (isUniqueViolation(err)) {
      // Lost a race against a concurrent create of the same URL.
      const winner = await getWebhookByAppAndUrl(appId, url);
      return webhookExists(winner?.id ?? null);
    }

    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to create webhook', { appId, error });
    return apiError({ status: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
