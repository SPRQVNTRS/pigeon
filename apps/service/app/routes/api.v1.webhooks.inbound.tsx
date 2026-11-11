/**
 * POST /v1/webhooks/inbound
 *
 * SNS → HTTPS endpoint for mail received through SES on a tenant's inbound
 * domain (receipt rule S3 action with an SNS topic). No API key: the SNS
 * signature and the configured topic (INBOUND_SNS_TOPIC_ARN) are the auth.
 *
 * The logic lives in app/lib/inbound/sns-inbound.ts; this file wires the I/O.
 */

import type { Route } from './+types/api.v1.webhooks.inbound';
import { CONFIG } from '#config';
import { verifySnsMessage } from '#app/lib/sns/verifier';
import { createComponentLogger } from '#app/lib/logger';
import { handleInboundSnsRequest } from '#app/lib/inbound/sns-inbound';
import { INBOUND_PROCESS_QUEUE } from '#app/lib/queue-names';
import { getOrchestrator } from '#app/services/workflows.server';
import { findEnabledInboundDomainsByNames } from '#app/models/inbound-domains.server';
import { deleteInboundEmail, insertInboundEmail } from '#app/models/inbound-emails.server';
import { INBOUND_PROCESS_SEND_OPTIONS } from '#app/workflows/inbound-process';

const log = createComponentLogger('InboundWebhookRoute');

export async function loader() {
  return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'POST' } });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'POST' } });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'Unable to read body' }, { status: 400 });
  }

  return handleInboundSnsRequest({
    rawBody,
    deps: {
      topicArn: CONFIG.inbound.snsTopicArn,
      log,
      verify: (envelope) => verifySnsMessage(envelope),
      confirmSubscription: async (subscribeUrl) => (await fetch(subscribeUrl)).ok,
      findDomains: (names) => findEnabledInboundDomainsByNames({ names }),
      insertEmail: (values) => insertInboundEmail({ values }),
      deleteEmail: (opts) => deleteInboundEmail(opts),
      enqueue: async (payload) => {
        const jobId = await getOrchestrator().getBoss().send(INBOUND_PROCESS_QUEUE, payload, {
          ...INBOUND_PROCESS_SEND_OPTIONS,
        });
        if (!jobId) throw new Error(`pg-boss refused the ${INBOUND_PROCESS_QUEUE} job`);
      },
    },
  });
}
