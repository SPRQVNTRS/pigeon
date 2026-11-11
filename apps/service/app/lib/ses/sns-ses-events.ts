/**
 * Request handling for POST /v1/webhooks/ses, with its I/O injected so tests
 * can drive it without SNS or pg-boss.
 *
 * SES publishes delivery, bounce and complaint events to one SNS topic. AWS
 * signs SNS messages for every account, so a valid signature alone proves
 * nothing: any AWS account can subscribe this URL to its own topic. The
 * configured topic is the auth.
 *
 *   1. SES_SNS_TOPIC_ARN unset              → 503 (one warning per process)
 *   2. Body is not an SNS envelope          → 400
 *   3. TopicArn is not that topic           → 403 (nothing fetched, confirmed
 *                                              or queued)
 *   4. SNS signature invalid                → 400
 *   5. SubscriptionConfirmation             → confirm (that topic only, and
 *                                              only an https SNS host)
 *   6. UnsubscribeConfirmation              → 200, warning, no-op
 *   7. Notification                         → queue ses.event.process
 *
 * Log lines hold ids, the topic ARN and the event type only, never the
 * message body.
 */

import type { Logger } from '#app/lib/logger';
import type { SnsEnvelope } from '#app/lib/sns/verifier';
import { parseSnsEnvelope } from '#app/lib/sns/envelope';
import { isSnsSubscribeUrl } from '#app/lib/sns/subscribe-url';
import type { SesNotification } from '#app/workflows/ses-event-process';

export interface SesSnsDeps {
  topicArn: string | undefined;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  verify: (envelope: SnsEnvelope) => Promise<boolean>;
  /** GET the SubscribeURL; true when SNS answered 2xx. */
  confirmSubscription: (subscribeUrl: string) => Promise<boolean>;
  /** Queue ses.event.process. Throws on queue errors. */
  enqueue: (payload: { notification: SesNotification }) => Promise<void>;
}

let hasWarnedTopicUnset = false;

/** Tests only. */
export function resetSesTopicWarning(): void {
  hasWarnedTopicUnset = false;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function isSignatureValid(opts: { envelope: SnsEnvelope; deps: SesSnsDeps }): Promise<boolean> {
  const { envelope, deps } = opts;
  try {
    return await deps.verify(envelope);
  } catch (err) {
    deps.log.warn('SES SNS signature verification threw', {
      messageId: envelope.MessageId,
      error: errorOf(err).name,
    });
    return false;
  }
}

async function confirm(opts: { envelope: SnsEnvelope; deps: SesSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;
  if (!envelope.SubscribeURL) return json({ error: 'Missing SubscribeURL' }, 400);
  if (!isSnsSubscribeUrl(envelope.SubscribeURL)) {
    deps.log.warn('SES SNS SubscribeURL is not an https SNS host, rejected', { topicArn: envelope.TopicArn });
    return json({ error: 'Invalid SubscribeURL' }, 400);
  }
  try {
    const isConfirmed = await deps.confirmSubscription(envelope.SubscribeURL);
    if (!isConfirmed) {
      deps.log.error('SubscribeURL confirm failed', { topicArn: envelope.TopicArn });
      return json({ error: 'Confirm fetch failed' }, 502);
    }
    deps.log.info('SNS subscription confirmed', { topicArn: envelope.TopicArn });
    return json({ ok: true, confirmed: true });
  } catch (err) {
    deps.log.error('SubscribeURL fetch threw', { topicArn: envelope.TopicArn, error: errorOf(err).name });
    return json({ error: 'Confirm fetch error' }, 502);
  }
}

async function handleNotification(opts: { envelope: SnsEnvelope; deps: SesSnsDeps }): Promise<Response> {
  const { envelope, deps } = opts;

  let notification: SesNotification;
  try {
    notification = JSON.parse(envelope.Message) as SesNotification;
  } catch {
    deps.log.warn('Notification Message is not JSON', { messageId: envelope.MessageId });
    return json({ error: 'Invalid Message JSON' }, 400);
  }

  try {
    await deps.enqueue({ notification });
    deps.log.info('Enqueued SES event', {
      messageId: envelope.MessageId,
      notificationType: notification.notificationType,
    });
    return json({ ok: true, queued: true });
  } catch (err) {
    deps.log.error('Failed to enqueue ses.event.process', { messageId: envelope.MessageId, error: errorOf(err) });
    return json({ error: 'Enqueue failed' }, 500);
  }
}

export async function handleSesSnsRequest(opts: { rawBody: string; deps: SesSnsDeps }): Promise<Response> {
  const { rawBody, deps } = opts;

  if (!deps.topicArn) {
    if (!hasWarnedTopicUnset) {
      hasWarnedTopicUnset = true;
      deps.log.warn('SES_SNS_TOPIC_ARN is not set; SES event ingest is off and the route answers 503');
    }
    return json({ error: 'SES event ingest is not configured' }, 503);
  }

  const envelope = parseSnsEnvelope(rawBody);
  if (!envelope) return json({ error: 'Malformed SNS envelope' }, 400);

  if (envelope.TopicArn !== deps.topicArn) {
    deps.log.warn('SES SNS message from an unexpected topic, rejected', {
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
      deps.log.warn('Received UnsubscribeConfirmation for SES SNS topic, no-op', {
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
