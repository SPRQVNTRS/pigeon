/**
 * inbound.process worker
 *
 * One job per received mail per inbound domain, carrying only
 * { inboundEmailId, appId }. Loads the inbound_emails row (scoped by app),
 * streams the raw mail from S3 through the MIME reader, and fans out one
 * `email.received` delivery per recipient to the owning app's webhooks, on
 * the webhook.deliver.inbound queue.
 *
 * After the MIME parse and before the fan-out it stores a keyed hash of the
 * From address on the row (app/lib/inbound/sender-hash.ts), so the recipient
 * erase can find this mail by the sender's address. The address itself is
 * never stored.
 *
 * It also decides whether the From address is authenticated
 * (app/lib/inbound/authentication.ts): the row's SES receipt verdicts gate
 * each check, the SES Authentication-Results header in the raw mail names the
 * domains. A replay runs this same worker, so it gets the same answer.
 *
 * The auto-reply headers (Auto-Submitted, Precedence, X-Auto-Response-Suppress)
 * are read in the MIME step (app/lib/inbound/auto-reply.ts) and go out as the
 * last payload key, `auto`.
 *
 * Privacy: log lines and thrown errors carry ids, counts, sizes and durations
 * only. Never an address, a domain, the subject or the body.
 *
 * Failure handling:
 *   - row gone (retention, wrong app)  → log, no delivery
 *   - S3 object gone (lifecycle)       → log, no delivery (a retry cannot help)
 *   - other S3 error / stream cut      → throw, pg-boss retries
 *   - unparseable MIME                 → log, no delivery
 *   - row gone before the hash write   → log, no delivery (an erase ran)
 */

import { z } from 'zod';
import type { Readable } from 'node:stream';
import { createComponentLogger } from '#app/lib/logger';
import { INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE } from '#app/lib/queue-names';
import { openS3Object, isS3NotFound, type S3ObjectStream } from '#app/lib/s3-client';
import { extractInboundMessage, InboundMimeError, type InboundMessage } from '#app/lib/inbound/mime';
import { buildEmailReceivedData, EMAIL_RECEIVED_EVENT, pickVerdicts } from '#app/lib/inbound/payload';
import { assessFromAuthentication } from '#app/lib/inbound/authentication';
import { enqueueWebhookFanout, type WebhookFanoutBoss } from '#app/lib/webhook-fanout';
import { inboundSenderHash } from '#app/lib/inbound/sender-hash';
import { normalizeAddress } from '#app/lib/email-address';
import { getInboundEmail, setInboundSenderHash, type InboundEmail } from '#app/models/inbound-emails.server';
import type { Database } from '#app/lib/db-types';

const log = createComponentLogger('InboundProcessWorker');

export { INBOUND_PROCESS_QUEUE };

/** pg-boss send options for inbound.process jobs. */
export const INBOUND_PROCESS_SEND_OPTIONS = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
} as const;

/**
 * One job at a time, polled every second. pg-boss 10 waits out the polling
 * interval after each fetch, so this caps the worker at about one mail per
 * second however large a burst is, and leaves the other queues their share.
 */
export const INBOUND_PROCESS_WORK_OPTIONS = { batchSize: 1, pollingIntervalSeconds: 1 } as const;

const inboundProcessPayloadSchema = z.object({
  inboundEmailId: z.string().min(1),
  appId: z.string().min(1),
});

export type InboundProcessPayload = z.infer<typeof inboundProcessPayloadSchema>;

interface InboundProcessJob {
  data: unknown;
}

export interface InboundBossWorker extends WebhookFanoutBoss {
  createQueue(name: string): Promise<void>;
  work(
    name: string,
    options: { batchSize: number; pollingIntervalSeconds?: number },
    handler: (jobs: InboundProcessJob[]) => Promise<void>,
  ): unknown;
}

export interface InboundProcessDeps {
  boss: WebhookFanoutBoss;
  /** Database for the row and the webhook lookup; defaults to the app pool. */
  db?: Database;
  loadEmail?: (opts: { appId: string; id: string }) => Promise<InboundEmail | null>;
  openObject?: (bucket: string, key: string) => Promise<S3ObjectStream>;
  readMessage?: (source: Readable) => Promise<InboundMessage>;
  /** Writes `sender_hash`; null when the row is gone. Defaults to the model function. */
  storeSenderHash?: (opts: { appId: string; id: string; senderHash: string }) => Promise<{ id: string } | null>;
}

export type InboundProcessOutcome =
  | 'invalid_job'
  | 'row_missing'
  | 'object_missing'
  | 'unparseable'
  | 'processed';

export async function registerInboundProcessWorker(boss: InboundBossWorker): Promise<void> {
  await boss.createQueue(INBOUND_PROCESS_QUEUE);
  boss.work(INBOUND_PROCESS_QUEUE, { ...INBOUND_PROCESS_WORK_OPTIONS }, async (jobs) => {
    const job = jobs[0];
    if (!job) return;
    await handleInboundProcess({ data: job.data, deps: { boss } });
  });
  log.info(`${INBOUND_PROCESS_QUEUE} worker registered`);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}

async function openRawMail(opts: {
  email: InboundEmail;
  openObject: NonNullable<InboundProcessDeps['openObject']>;
}): Promise<S3ObjectStream | null> {
  const { email } = opts;
  try {
    return await opts.openObject(email.s3Bucket, email.s3Key);
  } catch (err) {
    if (isS3NotFound(err)) return null;
    // No `cause`: pg-boss serialises the thrown error (nested own properties
    // included) into the job row, so only the id and the error name go in.
    throw new Error(`S3 fetch failed for inbound email ${email.id} (${errorName(err)})`);
  }
}

/**
 * Store the sender hash on the row. A mail without a From address has no
 * sender to erase, so nothing is stored. Returns false when the row is gone.
 */
async function recordSenderHash(opts: {
  email: InboundEmail;
  from: string;
  storeSenderHash: NonNullable<InboundProcessDeps['storeSenderHash']>;
}): Promise<boolean> {
  const sender = normalizeAddress(opts.from);
  if (sender === '') return true;
  const stored = await opts.storeSenderHash({
    appId: opts.email.appId,
    id: opts.email.id,
    senderHash: inboundSenderHash(sender),
  });
  return stored !== null;
}

export async function handleInboundProcess(opts: {
  data: unknown;
  deps: InboundProcessDeps;
}): Promise<InboundProcessOutcome> {
  const { deps } = opts;
  const loadEmail = deps.loadEmail ?? ((args) => getInboundEmail({ ...args, db: deps.db }));
  const openObject = deps.openObject ?? openS3Object;
  const readMessage = deps.readMessage ?? extractInboundMessage;
  const storeSenderHash = deps.storeSenderHash ?? ((args) => setInboundSenderHash({ ...args, db: deps.db }));
  const startedAt = Date.now();

  const parsed = inboundProcessPayloadSchema.safeParse(opts.data);
  if (!parsed.success) {
    log.warn('inbound.process job has no inboundEmailId/appId, dropped');
    return 'invalid_job';
  }
  const { inboundEmailId, appId } = parsed.data;

  const email = await loadEmail({ appId, id: inboundEmailId });
  if (!email) {
    log.warn('Inbound email row not found, no delivery', { inboundEmailId, appId });
    return 'row_missing';
  }

  const object = await openRawMail({ email, openObject });
  if (!object) {
    log.warn('Inbound raw mail no longer in S3, no delivery', { inboundEmailId, appId });
    return 'object_missing';
  }
  log.info('Inbound raw mail opened', { inboundEmailId, appId, sizeBytes: object.contentLength });

  let message: InboundMessage;
  try {
    message = await readMessage(object.body);
  } catch (err) {
    if (err instanceof InboundMimeError) {
      log.warn('Inbound mail is not parseable MIME, no delivery', { inboundEmailId, appId });
      return 'unparseable';
    }
    // Stream cut short or similar: let pg-boss retry. The message names ids only.
    throw new Error(`Reading inbound email ${inboundEmailId} failed (${errorName(err)})`);
  }

  const isRowPresent = await recordSenderHash({ email, from: message.from, storeSenderHash });
  if (!isRowPresent) {
    log.warn('Inbound email row gone before fan-out, no delivery', { inboundEmailId, appId });
    return 'row_missing';
  }

  const verdicts = pickVerdicts(email.verdicts);
  const assessment = assessFromAuthentication({
    fromAddress: message.from,
    hasSingleFrom: message.hasSingleFrom,
    verdicts,
    ses: message.sesAuthentication,
  });
  const deliveries = email.recipients.map((recipient) =>
    buildEmailReceivedData({ recipient, message, verdicts, assessment }),
  );

  const fanout = await enqueueWebhookFanout({
    boss: deps.boss,
    appId: email.appId,
    emailId: email.id,
    occurredAt: email.receivedAt,
    eventType: EMAIL_RECEIVED_EVENT,
    deliveries,
    queue: WEBHOOK_DELIVER_INBOUND_QUEUE,
    db: deps.db,
  });

  log.info('Inbound mail processed', {
    inboundEmailId,
    appId,
    recipientCount: deliveries.length,
    matchingHooks: fanout.matchingHooks,
    jobsQueued: fanout.jobsQueued,
    fromAuthenticated: assessment.from_authenticated,
    sesHeaderTrusted: assessment.authentication.ses_header_trusted,
    isAuto: message.autoReply.is_auto,
    textChars: message.text.length,
    attachmentBytesDiscarded: message.attachmentBytesDiscarded,
    durationMs: Date.now() - startedAt,
  });
  return 'processed';
}
