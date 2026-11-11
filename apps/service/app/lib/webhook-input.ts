import { z } from 'zod';
import { normaliseEventTypes } from '#app/lib/webhook-events';
import { normaliseWebhookUrl } from '#app/lib/webhook-url';

/** Zod field: validates and replaces the input with the normalised URL. */
export const webhookUrlSchema = z.string().transform((raw, ctx) => {
  const result = normaliseWebhookUrl(raw);
  if (result.ok) return result.url;
  ctx.addIssue({ code: 'custom', message: result.message });
  return z.NEVER;
});

/** Zod field: validates and replaces the input with the deduped event list. */
export const webhookEventTypesSchema = z.array(z.string()).transform((raw, ctx) => {
  const result = normaliseEventTypes(raw);
  if (result.ok) return result.eventTypes;
  ctx.addIssue({ code: 'custom', message: result.message });
  return z.NEVER;
});
