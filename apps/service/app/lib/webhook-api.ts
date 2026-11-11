import type { Webhook } from '#app/models/webhooks.server';

export interface PublicWebhook {
  id: string;
  appId: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit pick of the fields the admin API may expose. signingSecret is
 * deliberately absent. Never build this by deleting a key off the row, so a
 * new column stays private until someone adds it here.
 *
 * Null columns follow the delivery worker: eventTypes null means ['*'],
 * enabled null means not delivered (it selects `enabled = true`).
 */
export function toPublicWebhook(webhook: Webhook): PublicWebhook {
  return {
    id: webhook.id,
    appId: webhook.appId,
    url: webhook.url,
    eventTypes: webhook.eventTypes ?? ['*'],
    enabled: webhook.enabled === true,
    lastSuccessAt: webhook.lastSuccessAt,
    lastFailureAt: webhook.lastFailureAt,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

/** JSON response that no cache or proxy may store (bodies can hold secrets). */
export function noStoreJson(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, {
    status: init.status ?? 200,
    headers: { ...init.headers, 'Cache-Control': 'no-store' },
  });
}

export function apiError(options: {
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Response {
  return noStoreJson(
    { error: { code: options.code, message: options.message, ...options.extra } },
    { status: options.status, headers: options.headers },
  );
}
