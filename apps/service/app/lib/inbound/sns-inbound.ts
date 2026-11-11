/**
 * Request handling for POST /v1/webhooks/inbound, with its I/O injected so
 * tests can drive it without a database, SNS or pg-boss.
 *
 *   1. INBOUND_SNS_TOPIC_ARN unset          → 503 (one warning per process)
 *   2. TopicArn is not that topic           → 403
 *   3. SNS signature invalid                → 400
 *   4. SubscriptionConfirmation             → confirm (that topic only, and
 *                                              only an https SNS host)
 *   5. Notification with an SES receipt     → one inbound_emails row per
 *      matched inbound domain (ON CONFLICT DO NOTHING); only a new row
 *      queues inbound.process { inboundEmailId, appId }
 *
 * A notification that is not a valid SES receipt answers 200 with a warning,
 * so SNS does not retry it forever. A database or queue error answers 500 so
 * SNS retries. Log lines hold ids, counts, domain names and durations only.
 */

import type { Logger } from '#app/lib/logger';
import type { SnsEnvelope } from '#app/lib/sns/verifier';
import { parseSnsEnvelope } from '#app/lib/sns/envelope';
import { isSnsSubscribeUrl } from '#app/lib/sns/subscribe-url';
import type { InboundVerdicts } from '#drizzle/schema/inbound';
import { InvalidInboundNotificationError, parseInboundNotification, type InboundReceipt } from './notification';
import {
  groupRecipientsByDomain,
  recipientDomains,
  type InboundDomainRef,
  type RecipientGroup,
} from './recipients';

export interface NewInboundEmail {
  appId: string;
  inboundDomainId: string;
  sesMessageId: string;
  s3Bucket: string;
  s3Key: string;
  receivedAt: Date;
  recipientCount: number;
  recipients: string[];
  verdicts: InboundVerdicts;
}

export interface InboundSnsDeps {
  topicArn: string | undefined;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  verify: (envelope: SnsEnvelope) => Promise<boolean>;
  /** GET the SubscribeURL; true when SNS answered 2xx. */
  confirmSubscription: (subscribeUrl: string) => Promise<boolean>;
  findDomains: (names: string[]) => Promise<InboundDomainRef[]>;
  /** Insert or return null when the row exists already. */
  insertEmail: (values: NewInboundEmail) => Promise<{ id: string } | null>;
  /** Undo an insert whose job could not be queued, so the SNS retry inserts again. */
  deleteEmail: (opts: { appId: string; id: string }) => Promise<void>;
  enqueue: (payload: { inboundEmailId: string; appId: string }) => Promise<void>;
}

let hasWarnedTopicUnset = false;

/** Tests only. */
export function resetInboundTopicWarning(): void {
  hasWarnedTopicUnset = false;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function isSignatureValid(opts: { envelope: SnsEnvelope; deps: InboundSnsDeps }): Promise<boolean> {
  const { envelope, deps } = opts;
  try {
    return await deps.verify(envelope);
  } catch (err) {
    deps.log.warn('Inbound SNS signature verification threw', {
      messageId: envelope.MessageId,
      error: errorOf(err).name,
    });
    return false;
  }
}

async function confirm(opts: { envelope: SnsEnvelope; deps: InboundSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;
  if (!envelope.SubscribeURL) return json({ error: 'Missing SubscribeURL' }, 400);
  if (!isSnsSubscribeUrl(envelope.SubscribeURL)) {
    deps.log.warn('Inbound SNS SubscribeURL is not an https SNS host, rejected', { topicArn: envelope.TopicArn });
    return json({ error: 'Invalid SubscribeURL' }, 400);
  }
  try {
    const isConfirmed = await deps.confirmSubscription(envelope.SubscribeURL);
    if (!isConfirmed) {
      deps.log.error('Inbound SNS subscription confirm failed', { topicArn: envelope.TopicArn });
      return json({ error: 'Confirm fetch failed' }, 502);
    }
    deps.log.info('Inbound SNS subscription confirmed', { topicArn: envelope.TopicArn });
    return json({ ok: true, confirmed: true });
  } catch (err) {
    deps.log.error('Inbound SNS subscription confirm threw', {
      topicArn: envelope.TopicArn,
      error: errorOf(err).name,
    });
    return json({ error: 'Confirm fetch error' }, 502);
  }
}

interface StoreResult {
  queued: number;
  duplicates: number;
}

async function storeAndQueue(opts: {
  receipt: InboundReceipt;
  groups: ReadonlyArray<RecipientGroup<InboundDomainRef>>;
  deps: InboundSnsDeps;
}): Promise<StoreResult> {
  const { receipt, groups, deps } = opts;
  const result: StoreResult = { queued: 0, duplicates: 0 };

  for (const group of groups) {
    const row = await deps.insertEmail({
      appId: group.domain.appId,
      inboundDomainId: group.domain.id,
      sesMessageId: receipt.sesMessageId,
      s3Bucket: receipt.s3.bucket,
      s3Key: receipt.s3.key,
      receivedAt: receipt.receivedAt,
      recipientCount: group.recipients.length,
      recipients: group.recipients,
      verdicts: receipt.verdicts,
    });
    if (!row) {
      result.duplicates += 1;
      continue;
    }
    try {
      await deps.enqueue({ inboundEmailId: row.id, appId: group.domain.appId });
    } catch (err) {
      await deps.deleteEmail({ appId: group.domain.appId, id: row.id });
      throw err;
    }
    result.queued += 1;
  }
  return result;
}

async function handleNotification(opts: { envelope: SnsEnvelope; deps: InboundSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;
  const startedAt = Date.now();

  let receipt: InboundReceipt;
  try {
    receipt = parseInboundNotification(envelope.Message);
  } catch (err) {
    const reason = err instanceof InvalidInboundNotificationError ? err.message : 'unexpected parse error';
    deps.log.warn('Inbound notification is not an SES S3 receipt, ignored', {
      messageId: envelope.MessageId,
      reason,
    });
    return json({ ok: true, ignored: true });
  }

  try {
    const domains = await deps.findDomains(recipientDomains(receipt.recipients));
    const { groups, unmatchedCount } = groupRecipientsByDomain({ recipients: receipt.recipients, domains });
    const stored = await storeAndQueue({ receipt, groups, deps });

    deps.log.info('Inbound notification handled', {
      sesMessageId: receipt.sesMessageId,
      domains: groups.map((group) => group.domain.name),
      matchedRecipients: groups.reduce((sum, group) => sum + group.recipients.length, 0),
      unmatchedRecipients: unmatchedCount,
      queued: stored.queued,
      duplicates: stored.duplicates,
      durationMs: Date.now() - startedAt,
    });
    return json({ ok: true, queued: stored.queued, duplicates: stored.duplicates });
  } catch (err) {
    deps.log.error('Inbound notification could not be stored, SNS will retry', {
      sesMessageId: receipt.sesMessageId,
      error: errorOf(err).name,
    });
    return json({ error: 'Storage failed' }, 500);
  }
}

export async function handleInboundSnsRequest(opts: { rawBody: string; deps: InboundSnsDeps }): Promise<Response> {
  const { rawBody, deps } = opts;

  if (!deps.topicArn) {
    if (!hasWarnedTopicUnset) {
      hasWarnedTopicUnset = true;
      deps.log.warn('INBOUND_SNS_TOPIC_ARN is not set; inbound mail is off and the route answers 503');
    }
    return json({ error: 'Inbound mail is not configured' }, 503);
  }

  const envelope = parseSnsEnvelope(rawBody);
  if (!envelope) return json({ error: 'Malformed SNS envelope' }, 400);

  if (envelope.TopicArn !== deps.topicArn) {
    deps.log.warn('Inbound SNS message from an unexpected topic, rejected', {
      messageId: envelope.MessageId,
      topicArn: envelope.TopicArn,
    });
    return json({ error: 'Unexpected topic' }, 403);
  }

  if (!(await isSignatureValid({ envelope, deps }))) {
    deps.log.warn('Inbound SNS message with invalid signature, rejected', { messageId: envelope.MessageId });
    return json({ error: 'Invalid signature' }, 400);
  }

  switch (envelope.Type) {
    case 'SubscriptionConfirmation':
      return confirm({ envelope, deps });
    case 'UnsubscribeConfirmation':
      deps.log.warn('Inbound SNS UnsubscribeConfirmation received, no-op', { topicArn: envelope.TopicArn });
      return json({ ok: true });
    case 'Notification':
      return handleNotification({ envelope, deps });
    default:
      deps.log.warn('Unknown inbound SNS envelope type, ignored', { type: envelope.Type });
      return json({ ok: true, ignored: true });
  }
}
