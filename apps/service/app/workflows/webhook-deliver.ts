/**
 * webhook.deliver worker
 *
 * Signs and POSTs a webhook payload to a consumer endpoint.
 *
 * Signature scheme (Stripe-style):
 *     Pigeon-Signature: t=<unix_ts>,v1=<hmac_sha256_hex>
 * where the HMAC input is `<unix_ts>.<raw_body>` and the key is the webhook's
 * signing secret. Header names live in `#app/lib/webhook-headers`.
 *
 * Retries are handled by pg-boss via `retryLimit: 5, retryDelay: 1,
 * retryBackoff: true` at enqueue time. This worker throws on a failed attempt
 * (network error, timeout, non-2xx answer), and pg-boss retries it.
 *
 * Target rules (app/lib/webhook-target.ts), checked on every attempt of both
 * queues: the URL must be http or https with no credentials, else the attempt
 * fails without a request. Under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny (the default) the POST
 * goes through the pinned transport: the host is resolved once, any answer the
 * address rule refuses (non-public, unless PIGEON_WEBHOOK_PRIVATE_HOSTS lists
 * the host and the address is a private network one) refuses it, the socket
 * connects to the checked address and a redirect is not followed. Under
 * `allow` (which the deployment must set) the POST uses fetch and follows
 * redirects.
 *
 * A refused target is final for that delivery. A retry would get the same
 * answer, so the worker does not throw: it stamps `last_failure_at`, logs the
 * reason and returns it as the job output, the way email.send ends a permanent
 * SES error. pg-boss marks the job completed and runs no retry. The webhook
 * stays enabled.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createComponentLogger } from '#app/lib/logger';
import { WEBHOOK_DELIVER_INBOUND_QUEUE, WEBHOOK_DELIVER_QUEUE } from '#app/lib/queue-names';
import { buildWebhookHeaders } from '#app/lib/webhook-headers';
import {
  checkWebhookUrlShape,
  createDenyAddressRule,
  resolveHostWithSystemDns,
  WebhookTargetRefusedError,
  type AddressRule,
  type ResolveHost,
} from '#app/lib/webhook-target';
import { createPinnedTransport, fetchTransport, type WebhookTransport } from '#app/lib/webhook-transport';
import {
  resolveWebhookPrivateHosts,
  resolveWebhookPrivateTargets,
  type WebhookPrivateTargets,
} from '#app/config/deployment-settings';
import { db } from '#drizzle/db';
import { webhooks } from '#drizzle/schema';
import { eq } from 'drizzle-orm';

const log = createComponentLogger('WebhookDeliverWorker');

// Defined in #app/lib/queue-names, re-exported for existing importers.
export { WEBHOOK_DELIVER_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE };

/**
 * Budget for a single delivery attempt.
 *
 * 15 s. The receiver is a consumer-supplied, untrusted URL, so its behaviour is
 * by definition not ours to trust — this bound is the only thing between an
 * indefinitely slow third party and a stalled worker slot. 15 s is generous
 * enough for a cold-starting serverless receiver yet short enough that a hung
 * endpoint costs one attempt, not five minutes; pg-boss retries the attempt with
 * backoff, so failing fast is cheap. Unbounded, this call inherited undici's
 * invisible 300 s default.
 */
const WEBHOOK_DELIVER_TIMEOUT_MS = 15_000;

export interface WebhookDeliverPayload {
  webhookId: string;
  url: string;
  signingSecret: string;
  eventType: string;
  /** The event body to POST; will be JSON.stringify'd once. */
  payload: Record<string, unknown>;
}

interface WebhookDeliverJob {
  data: WebhookDeliverPayload;
}

export interface BossWorker {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    options: { batchSize: number; pollingIntervalSeconds?: number },
    handler: (jobs: WebhookDeliverJob[]) => Promise<WebhookDeliverOutput | undefined>,
  ): unknown;
}

/**
 * Register the webhook.deliver worker with the given pg-boss instance.
 * Creates the queue first (idempotent — pg-boss uses ON CONFLICT DO NOTHING).
 */
export async function registerWebhookDeliverWorker(boss: BossWorker): Promise<void> {
  await boss.createQueue(WEBHOOK_DELIVER_QUEUE);
  boss.work(WEBHOOK_DELIVER_QUEUE, { batchSize: 1 }, handleWebhookDeliver);
  log.info(`${WEBHOOK_DELIVER_QUEUE} worker registered`);
}

/**
 * Register the webhook.deliver.inbound worker: same signing and retries, one
 * job at a time, on its own queue so a burst of received mail never waits in
 * front of bounce and complaint deliveries. Its payloads hold a mail body, so
 * a failed attempt never copies the receiver's answer into a log line or the
 * job output (a receiver could echo the payload back).
 */
export async function registerInboundWebhookDeliverWorker(boss: BossWorker): Promise<void> {
  await boss.createQueue(WEBHOOK_DELIVER_INBOUND_QUEUE);
  boss.work(
    WEBHOOK_DELIVER_INBOUND_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: INBOUND_POLLING_INTERVAL_SECONDS },
    handleInboundWebhookDeliver,
  );
  log.info(`${WEBHOOK_DELIVER_INBOUND_QUEUE} worker registered`);
}

/**
 * pg-boss 10 waits `pollingInterval - duration` after every fetch, even when
 * it found a job, so a one-at-a-time worker runs at most one job per interval.
 * One second instead of the default two doubles burst throughput.
 */
export const INBOUND_POLLING_INTERVAL_SECONDS = 1;

/**
 * Build the signed headers for an outbound webhook request.
 * Exposed for unit testing.
 */
export function buildSignedHeaders(opts: {
  signingSecret: string;
  rawBody: string;
  eventType: string;
  deliveryId: string;
  timestamp?: number;
}): Record<string, string> {
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${opts.rawBody}`;
  const signature = createHmac('sha256', opts.signingSecret).update(signedPayload).digest('hex');
  return buildWebhookHeaders({
    signature: `t=${t},v1=${signature}`,
    timestamp: t,
    eventType: opts.eventType,
    deliveryId: opts.deliveryId,
  });
}

/**
 * Verify a signature emitted by `buildSignedHeaders`. Exposed for tests /
 * consumer apps that want to reuse the same logic.
 */
export function verifyWebhookSignature(opts: {
  signingSecret: string;
  rawBody: string;
  header: string;
}): boolean {
  const match = opts.header.match(/^t=(\d+),v1=([0-9a-f]+)$/);
  if (!match) return false;
  const t = match[1]!;
  const provided = Buffer.from(match[2]!, 'hex');
  const expected = createHmac('sha256', opts.signingSecret)
    .update(`${t}.${opts.rawBody}`)
    .digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Names the timeout explicitly — the platform's abort message does not say which
 * budget was exceeded, and this is the failure operators will see most often.
 */
function isTimeout(err: Error): boolean {
  // fetch throws the TimeoutError itself; node:http throws an AbortError with it as the cause.
  return err.name === 'TimeoutError' || (err.cause instanceof Error && err.cause.name === 'TimeoutError');
}

function describeDeliveryError(err: unknown): string {
  if (err instanceof Error && isTimeout(err)) {
    return `Timed out after ${WEBHOOK_DELIVER_TIMEOUT_MS}ms`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * What a delivery reads from outside. Production uses the defaults; tests
 * replace the resolver, the settings and (to reach a local test server) the
 * address rule of the deny setting.
 */
export interface WebhookDeliveryDeps {
  resolvePolicy: () => WebhookPrivateTargets;
  resolveHost: ResolveHost;
  /** The address rule under `deny`. Read once per attempt. */
  resolveAddressRule: () => AddressRule;
}

const DEFAULT_DELIVERY_DEPS: WebhookDeliveryDeps = {
  resolvePolicy: resolveWebhookPrivateTargets,
  resolveHost: resolveHostWithSystemDns,
  resolveAddressRule: () => createDenyAddressRule({ privateHosts: resolveWebhookPrivateHosts() }),
};

const SNIPPET_MAX_CHARS = 200;

/**
 * The job output of a delivery that ended without a retry. pg-boss stores it
 * on the completed job, and the admin jobs view shows `message`.
 */
export interface WebhookDeliverOutput {
  outcome: 'refused';
  message: string;
}

/**
 * One attempt. `failed` is retried. `refused` is final: the target rules
 * refuse the URL, and a retry would get the same answer.
 */
type AttemptOutcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'failed'; status: number; errorMsg: string }
  | { kind: 'refused'; reason: string };

function transportFor(opts: { policy: WebhookPrivateTargets; deps: WebhookDeliveryDeps }): WebhookTransport {
  if (opts.policy === 'allow') return fetchTransport;
  const isAllowedAddress = opts.deps.resolveAddressRule();
  return createPinnedTransport({ resolveHost: opts.deps.resolveHost, isAllowedAddress });
}

function handleWebhookDeliver(jobs: WebhookDeliverJob[]): Promise<WebhookDeliverOutput | undefined> {
  return deliverWebhookJob({ jobs, includeResponseSnippet: true });
}

function handleInboundWebhookDeliver(jobs: WebhookDeliverJob[]): Promise<WebhookDeliverOutput | undefined> {
  return deliverWebhookJob({ jobs, includeResponseSnippet: false });
}

/**
 * One attempt. Never throws for the request itself. It throws only when a
 * deployment setting holds an invalid value, which fails the job like any
 * other fault, so the attempt is retried after the operator fixes the value.
 */
async function attemptDelivery(opts: {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  includeResponseSnippet: boolean;
  deps: WebhookDeliveryDeps;
}): Promise<AttemptOutcome> {
  const shape = checkWebhookUrlShape(opts.url);
  if (!shape.ok) return { kind: 'refused', reason: `Target refused: ${shape.reason}` };

  const policy = opts.deps.resolvePolicy();
  const transport = transportFor({ policy, deps: opts.deps });
  try {
    const res = await transport({
      url: opts.url,
      headers: opts.headers,
      body: opts.rawBody,
      signal: AbortSignal.timeout(WEBHOOK_DELIVER_TIMEOUT_MS),
    });
    if (res.status >= 200 && res.status < 300) {
      res.discard();
      return { kind: 'delivered', status: res.status };
    }
    if (res.status >= 300 && res.status < 400 && policy === 'deny') {
      res.discard();
      return { kind: 'failed', status: res.status, errorMsg: `HTTP ${res.status} (redirects are not followed)` };
    }
    // Read a small snippet for diagnostics; don't block on it.
    const snippet = opts.includeResponseSnippet ? await res.readSnippet(SNIPPET_MAX_CHARS) : '';
    if (!opts.includeResponseSnippet) res.discard();
    return { kind: 'failed', status: res.status, errorMsg: `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}` };
  } catch (err) {
    if (err instanceof WebhookTargetRefusedError) return { kind: 'refused', reason: `Target refused: ${err.message}` };
    return { kind: 'failed', status: 0, errorMsg: describeDeliveryError(err) };
  }
}

/** Stamps last_success_at or last_failure_at. Best-effort: a failed write does not fail the job. */
async function stampWebhookOutcome(opts: { webhookId: string; isDelivered: boolean }): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(webhooks)
      .set(opts.isDelivered ? { lastSuccessAt: now } : { lastFailureAt: now })
      .where(eq(webhooks.id, opts.webhookId));
  } catch (dbErr) {
    log.warn('Failed to update webhook timestamp', {
      webhookId: opts.webhookId,
      error: dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
    });
  }
}

async function deliverWebhookJob(opts: {
  jobs: WebhookDeliverJob[];
  includeResponseSnippet: boolean;
  deps?: WebhookDeliveryDeps;
}): Promise<WebhookDeliverOutput | undefined> {
  const job = opts.jobs[0];
  if (!job) return undefined;
  const deps = opts.deps ?? DEFAULT_DELIVERY_DEPS;

  const { webhookId, url, signingSecret, eventType, payload } = job.data;
  const deliveryId = String(payload.id ?? crypto.randomUUID());
  const rawBody = JSON.stringify(payload);

  const headers = buildSignedHeaders({
    signingSecret,
    rawBody,
    eventType,
    deliveryId,
  });

  log.debug('Delivering webhook', { webhookId, url, eventType, deliveryId });

  const outcome = await attemptDelivery({
    url,
    headers,
    rawBody,
    includeResponseSnippet: opts.includeResponseSnippet,
    deps,
  });

  await stampWebhookOutcome({ webhookId, isDelivered: outcome.kind === 'delivered' });

  switch (outcome.kind) {
    case 'delivered':
      log.info('Webhook delivered', { webhookId, url, status: outcome.status });
      return undefined;
    case 'refused':
      // No throw: a throw makes pg-boss retry, and a refusal does not change.
      log.error('Webhook target refused, no retry', { webhookId, url, reason: outcome.reason });
      return { outcome: 'refused', message: outcome.reason };
    case 'failed':
      log.warn('Webhook delivery failed, will retry', {
        webhookId,
        url,
        status: outcome.status,
        errorMsg: outcome.errorMsg,
      });
      // Throw so pg-boss retries per the enqueue-time retry config.
      throw new Error(outcome.errorMsg);
  }
}

export const __test__ = { handleWebhookDeliver, handleInboundWebhookDeliver, deliverWebhookJob };
