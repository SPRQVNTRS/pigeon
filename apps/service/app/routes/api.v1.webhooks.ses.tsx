/**
 * POST /v1/webhooks/ses
 *
 * SNS → HTTPS endpoint for SES bounce/complaint/delivery notifications.
 *
 * No API key: the configured topic (SES_SNS_TOPIC_ARN; unset means 503) and
 * the SNS signature are the auth. A message from any other topic answers 403
 * before anything is fetched, confirmed or queued. AWS signs messages for
 * every account, so the signature alone would let any AWS account forge
 * bounces and complaints.
 *
 * Flow: topic check → signature → SubscriptionConfirmation (that topic only,
 * SNS host only) or Notification → enqueue `ses.event.process`.
 *
 * The logic lives in app/lib/ses/sns-ses-events.ts; this file wires the I/O.
 */

import type { Route } from './+types/api.v1.webhooks.ses';
import { CONFIG } from '#config';
import { verifySnsMessage } from '#app/lib/sns/verifier';
import { createComponentLogger } from '#app/lib/logger';
import { handleSesSnsRequest } from '#app/lib/ses/sns-ses-events';
import { getOrchestrator } from '#app/services/workflows.server';
import { SES_EVENT_QUEUE } from '#app/workflows/ses-event-process';

const log = createComponentLogger('SnsWebhookRoute');

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'Unable to read body' }, { status: 400 });
  }

  return handleSesSnsRequest({
    rawBody,
    deps: {
      topicArn: CONFIG.sesEvents.snsTopicArn,
      log,
      verify: (envelope) => verifySnsMessage(envelope),
      confirmSubscription: async (subscribeUrl) => (await fetch(subscribeUrl)).ok,
      enqueue: async (payload) => {
        await getOrchestrator().getBoss().send(SES_EVENT_QUEUE, payload);
      },
    },
  });
}
