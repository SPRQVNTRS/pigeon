/**
 * Request handling for POST /v1/webhooks/dmarc, with its I/O injected so tests
 * can drive it without a database, SNS or S3.
 *
 * DMARC aggregate reports arrive as mail to dmarc@<receiving domain>. The SES
 * receipt rule stores the raw mail in S3 and publishes an SES receipt
 * notification (`notificationType: "Received"`) to the DMARC SNS topic.
 *
 *   1. DMARC_SNS_TOPIC_ARN unset            → 503 (one warning per process)
 *   2. Body is not an SNS envelope          → 400
 *   3. TopicArn is not that topic           → 403 (nothing fetched or confirmed)
 *   4. SNS signature invalid                → 400
 *   5. SubscriptionConfirmation             → confirm (that topic only, and
 *                                              only an https SNS host)
 *   6. Notification:
 *      a. not an SES S3 receipt notice      → 200, ignored (SES setup notices)
 *      b. the SES setup test object         → 200, skipped
 *      c. virus verdict FAIL                → 200, skipped
 *      d. read the mail from S3, capped at DMARC_MAX_MAIL_BYTES
 *         (over the cap → 200, skipped; S3 error → 500 so SNS retries)
 *      e. MIME-parse, decompress each report attachment (capped per
 *         attachment, see mime.ts), parse the XML, store it
 *
 * Permanent faults (bad MIME, bad XML, an oversized attachment) answer 200 so
 * SNS does not retry them forever. Log lines hold ids, S3 keys, counts, the
 * reporting org and the policy domain only; reasons never quote the input.
 */

import type { Logger } from '#app/lib/logger';
import type { S3ObjectStream } from '#app/lib/s3-client';
import type { SnsEnvelope } from '#app/lib/sns/verifier';
import { parseSnsEnvelope } from '#app/lib/sns/envelope';
import { isSnsSubscribeUrl } from '#app/lib/sns/subscribe-url';
import {
  InvalidInboundNotificationError,
  parseInboundNotification,
  type InboundReceipt,
} from '#app/lib/inbound/notification';
import { DmarcAttachmentTooLargeError, decompressAttachment, extractDmarcAttachments } from './mime';
import { parseDmarcXml, type DmarcReport } from './parser';

/** Most bytes of raw mail read from S3. A real report mail is far below this. */
export const DMARC_MAX_MAIL_BYTES = 10 * 1024 * 1024;

/** Name SES gives the test object it writes when an S3 action is set up. */
const SES_SETUP_NOTIFICATION = 'AMAZON_SES_SETUP_NOTIFICATION';

export interface StoreDmarcReportInput {
  report: DmarcReport;
  /** S3 key of the raw report mail. */
  sourceS3Key: string;
  /** SNS MessageId of the notification that delivered it. */
  sourceMessageId: string | null;
}

export interface DmarcSnsDeps {
  topicArn: string | undefined;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  verify: (envelope: SnsEnvelope) => Promise<boolean>;
  /** GET the SubscribeURL; true when SNS answered 2xx. */
  confirmSubscription: (subscribeUrl: string) => Promise<boolean>;
  /** Open the raw mail without buffering it. Throws on S3 errors. */
  openObject: (location: { bucket: string; key: string }) => Promise<S3ObjectStream>;
  /** Upsert the report and replace its records. Throws on database errors. */
  storeReport: (input: StoreDmarcReportInput) => Promise<{ id: number }>;
}

/** The raw mail is larger than DMARC_MAX_MAIL_BYTES. Permanent. */
export class DmarcMailTooLargeError extends Error {
  constructor() {
    super(`DMARC report mail over the ${DMARC_MAX_MAIL_BYTES} byte cap`);
    this.name = 'DmarcMailTooLargeError';
  }
}

let hasWarnedTopicUnset = false;

/** Tests only. */
export function resetDmarcTopicWarning(): void {
  hasWarnedTopicUnset = false;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function isSignatureValid(opts: { envelope: SnsEnvelope; deps: DmarcSnsDeps }): Promise<boolean> {
  const { envelope, deps } = opts;
  try {
    return await deps.verify(envelope);
  } catch (err) {
    deps.log.warn('DMARC SNS signature verification threw', {
      messageId: envelope.MessageId,
      error: errorOf(err).name,
    });
    return false;
  }
}

async function confirm(opts: { envelope: SnsEnvelope; deps: DmarcSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;
  if (!envelope.SubscribeURL) return json({ error: 'Missing SubscribeURL' }, 400);
  if (!isSnsSubscribeUrl(envelope.SubscribeURL)) {
    deps.log.warn('DMARC SNS SubscribeURL is not an https SNS host, rejected', { topicArn: envelope.TopicArn });
    return json({ error: 'Invalid SubscribeURL' }, 400);
  }
  try {
    const isConfirmed = await deps.confirmSubscription(envelope.SubscribeURL);
    if (!isConfirmed) {
      deps.log.error('SubscribeURL confirm failed', { topicArn: envelope.TopicArn });
      return json({ error: 'Confirm fetch failed' }, 502);
    }
    deps.log.info('DMARC SNS subscription confirmed', { topicArn: envelope.TopicArn });
    return json({ ok: true, confirmed: true });
  } catch (err) {
    deps.log.error('SubscribeURL fetch threw', { topicArn: envelope.TopicArn, error: errorOf(err).name });
    return json({ error: 'Confirm fetch error' }, 502);
  }
}

function isSesSetupNotice(receipt: InboundReceipt): boolean {
  const keyName = receipt.s3.key.split('/').pop();
  return receipt.sesMessageId === SES_SETUP_NOTIFICATION || keyName === SES_SETUP_NOTIFICATION;
}

/**
 * Read a stream into one Buffer, refusing more than maxBytes: first by the
 * declared Content-Length (nothing read), then by counting while reading.
 *
 * @throws DmarcMailTooLargeError over the cap; stream errors as they come
 */
export async function readMailCapped(opts: { object: S3ObjectStream; maxBytes: number }): Promise<Buffer> {
  const { object, maxBytes } = opts;
  if (object.contentLength !== null && object.contentLength > maxBytes) {
    object.body.destroy();
    throw new DmarcMailTooLargeError();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > maxBytes) {
      object.body.destroy();
      throw new DmarcMailTooLargeError();
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

type AttachmentOutcome = 'stored' | 'skipped';

/**
 * Decompress, parse and store one attachment. A decompression or XML fault is
 * permanent and answers 'skipped'. A storage fault throws, so SNS retries.
 */
async function ingestAttachment(opts: {
  attachment: Buffer;
  receipt: InboundReceipt;
  envelope: SnsEnvelope;
  startedAt: number;
  deps: DmarcSnsDeps;
}): Promise<AttachmentOutcome> {
  const { attachment, receipt, envelope, startedAt, deps } = opts;
  const { bucket, key } = receipt.s3;

  let xml: string;
  try {
    xml = await decompressAttachment(attachment);
  } catch (err) {
    if (err instanceof DmarcAttachmentTooLargeError) {
      deps.log.warn(`dmarc: attachment over the decompression cap s3://${bucket}/${key} error=${err.message}`);
      return 'skipped';
    }
    deps.log.error(`dmarc: decompress error s3://${bucket}/${key} error=${errorOf(err).message}`);
    return 'skipped';
  }

  let report: DmarcReport;
  try {
    report = parseDmarcXml(xml);
  } catch (err) {
    deps.log.error(`dmarc: parse error s3://${bucket}/${key} error=${errorOf(err).message}`);
    return 'skipped';
  }

  const stored = await deps.storeReport({
    report,
    sourceS3Key: key,
    sourceMessageId: envelope.MessageId ?? null,
  });
  deps.log.info(
    `dmarc: upserted report_id=${stored.id} org=${report.orgName} domain=${report.policyDomain} records=${report.records.length} duration_ms=${Date.now() - startedAt}`,
  );
  return 'stored';
}

async function readMail(opts: { receipt: InboundReceipt; deps: DmarcSnsDeps }): Promise<Buffer> {
  const { receipt, deps } = opts;
  const object = await deps.openObject({ bucket: receipt.s3.bucket, key: receipt.s3.key });
  return readMailCapped({ object, maxBytes: DMARC_MAX_MAIL_BYTES });
}

async function ingestMail(opts: {
  receipt: InboundReceipt;
  envelope: SnsEnvelope;
  deps: DmarcSnsDeps;
}): Promise<Response> {
  const { receipt, envelope, deps } = opts;
  const { bucket, key } = receipt.s3;
  deps.log.info(`dmarc: processing s3://${bucket}/${key} message_id=${envelope.MessageId}`);
  const startedAt = Date.now();

  let rawEmail: Buffer;
  try {
    rawEmail = await readMail({ receipt, deps });
  } catch (err) {
    if (err instanceof DmarcMailTooLargeError) {
      deps.log.warn(`dmarc: mail over the ${DMARC_MAX_MAIL_BYTES} byte cap, skipped s3://${bucket}/${key}`);
      return json({ ok: true, skipped: 'too_large' });
    }
    deps.log.error(`dmarc: S3 fetch error s3://${bucket}/${key}`, { error: errorOf(err) });
    return json({ error: 'S3 fetch failed' }, 500);
  }

  let attachments: Buffer[];
  try {
    attachments = await extractDmarcAttachments(rawEmail);
  } catch (err) {
    deps.log.error(`dmarc: MIME parse error s3://${bucket}/${key}`, { error: errorOf(err) });
    return json({ ok: true, warning: 'MIME parse failed' });
  }

  if (attachments.length === 0) {
    deps.log.warn(`dmarc: no DMARC attachments found in s3://${bucket}/${key}`);
    return json({ ok: true, stored: 0, skipped: 0 });
  }

  let storedCount = 0;
  let skippedCount = 0;
  for (const attachment of attachments) {
    try {
      const outcome = await ingestAttachment({ attachment, receipt, envelope, startedAt, deps });
      if (outcome === 'stored') storedCount += 1;
      if (outcome === 'skipped') skippedCount += 1;
    } catch (err) {
      deps.log.error(`dmarc: report could not be stored s3://${bucket}/${key}, SNS will retry`, {
        error: errorOf(err).name,
      });
      return json({ error: 'Storage failed' }, 500);
    }
  }
  return json({ ok: true, stored: storedCount, skipped: skippedCount });
}

async function handleNotification(opts: { envelope: SnsEnvelope; deps: DmarcSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;

  let receipt: InboundReceipt;
  try {
    receipt = parseInboundNotification(envelope.Message);
  } catch (err) {
    const reason = err instanceof InvalidInboundNotificationError ? err.message : 'unexpected parse error';
    deps.log.warn('dmarc: notification is not an SES S3 receipt, ignored', {
      messageId: envelope.MessageId,
      reason,
    });
    return json({ ok: true, ignored: true });
  }

  if (isSesSetupNotice(receipt)) {
    deps.log.info('dmarc: SES setup notification, skipped', { messageId: envelope.MessageId });
    return json({ ok: true, skipped: 'setup_notification' });
  }

  if (receipt.verdicts.virus === 'FAIL') {
    deps.log.warn(`dmarc: virus verdict FAIL, skipped s3://${receipt.s3.bucket}/${receipt.s3.key}`, {
      sesMessageId: receipt.sesMessageId,
    });
    return json({ ok: true, skipped: 'virus' });
  }

  return ingestMail({ receipt, envelope, deps });
}

export async function handleDmarcSnsRequest(opts: { rawBody: string; deps: DmarcSnsDeps }): Promise<Response> {
  const { rawBody, deps } = opts;

  if (!deps.topicArn) {
    if (!hasWarnedTopicUnset) {
      hasWarnedTopicUnset = true;
      deps.log.warn('DMARC_SNS_TOPIC_ARN is not set; DMARC report ingest is off and the route answers 503');
    }
    return json({ error: 'DMARC report ingest is not configured' }, 503);
  }

  const envelope = parseSnsEnvelope(rawBody);
  if (!envelope) return json({ error: 'Malformed SNS envelope' }, 400);

  if (envelope.TopicArn !== deps.topicArn) {
    deps.log.warn('DMARC SNS message from an unexpected topic, rejected', {
      messageId: envelope.MessageId,
      topicArn: envelope.TopicArn,
    });
    return json({ error: 'Unexpected topic' }, 403);
  }

  if (!(await isSignatureValid({ envelope, deps }))) {
    deps.log.warn('Rejected SNS message with invalid signature', { messageId: envelope.MessageId });
    return json({ error: 'Invalid signature' }, 400);
  }

  switch (envelope.Type) {
    case 'SubscriptionConfirmation':
      return confirm({ envelope, deps });
    case 'UnsubscribeConfirmation':
      deps.log.warn('Received UnsubscribeConfirmation for DMARC SNS topic, no-op', {
        topicArn: envelope.TopicArn,
        messageId: envelope.MessageId,
      });
      return json({ ok: true });
    case 'Notification':
      return handleNotification({ envelope, deps });
    default:
      deps.log.warn('Unknown SNS envelope Type, ignored', { type: envelope.Type });
      return json({ ok: true, ignored: true });
  }
}
