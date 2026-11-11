/**
 * Webhook fan-out: one signed delivery per event body, to every enabled
 * webhook of the owning app whose event types include the event (or '*').
 *
 * Shared by ses.event.process (bounce, complaint, delivery) and
 * inbound.process (email.received). The job shape and the retry options are
 * the contract of the webhook.deliver worker; do not change them per caller.
 */

import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '#drizzle/db';
import type { Database } from '#app/lib/db-types';
import { webhooks, type SelectWebhook } from '#drizzle/schema';
import { WEBHOOK_DELIVER_QUEUE } from '#app/lib/queue-names';

/** The JSON body a consumer receives. Key order is part of the signed bytes. */
export interface WebhookPayload {
  id: string;
  type: string;
  organization_id: string;
  email_id: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface WebhookFanoutBoss {
  send(name: string, data: object, options?: Record<string, unknown>): Promise<string | null>;
}

/** pg-boss retry options of every webhook delivery job. */
export const WEBHOOK_DELIVER_RETRY_OPTIONS = {
  retryLimit: 5,
  retryDelay: 1,
  retryBackoff: true,
} as const;

export function matchesEventType(hook: SelectWebhook, eventType: string): boolean {
  const types = hook.eventTypes ?? ['*'];
  return types.includes('*') || types.includes(eventType);
}

export interface WebhookFanoutResult {
  matchingHooks: number;
  jobsQueued: number;
}

/**
 * Queue one delivery per entry of `deliveries` (one `data` object each) to
 * every matching webhook of `appId`. Each entry gets its own delivery id; the
 * same payload goes to every matching hook.
 */
export async function enqueueWebhookFanout(opts: {
  boss: WebhookFanoutBoss;
  appId: string;
  emailId: string;
  occurredAt: Date;
  eventType: string;
  deliveries: ReadonlyArray<Record<string, unknown>>;
  queue?: string;
  db?: Database;
}): Promise<WebhookFanoutResult> {
  const { boss, appId, emailId, occurredAt, eventType, deliveries, queue = WEBHOOK_DELIVER_QUEUE } = opts;
  const db = opts.db ?? defaultDb;

  const hooks = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.appId, appId), eq(webhooks.enabled, true)));

  const matching = hooks.filter((h) => matchesEventType(h, eventType));
  if (matching.length === 0) return { matchingHooks: 0, jobsQueued: 0 };

  let jobsQueued = 0;
  for (const data of deliveries) {
    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      type: eventType,
      organization_id: appId,
      email_id: emailId,
      occurred_at: occurredAt.toISOString(),
      data,
    };

    for (const hook of matching) {
      await boss.send(
        queue,
        {
          webhookId: hook.id,
          url: hook.url,
          signingSecret: hook.signingSecret,
          eventType,
          payload,
        },
        { ...WEBHOOK_DELIVER_RETRY_OPTIONS },
      );
      jobsQueued += 1;
    }
  }

  return { matchingHooks: matching.length, jobsQueued };
}
