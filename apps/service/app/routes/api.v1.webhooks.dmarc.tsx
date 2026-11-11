/**
 * POST /v1/webhooks/dmarc
 *
 * SNS → HTTPS endpoint for DMARC aggregate reports. Reporters mail them to
 * dmarc@<receiving domain>; the SES receipt rule stores the raw mail in S3 and
 * publishes an SES receipt notification (`notificationType: "Received"`, with
 * `receipt.action.bucketName` / `objectKey`) to the DMARC SNS topic.
 *
 * No API key: the configured topic (DMARC_SNS_TOPIC_ARN; unset means 503) and
 * the SNS signature are the auth. A message from any other topic answers 403
 * before anything is fetched or confirmed.
 *
 * Flow: topic check → signature → SubscriptionConfirmation (that topic only)
 * or Notification → read the mail from S3 (capped at 10 MB) → MIME-parse →
 * decompress each attachment (capped at 20 MB) → parse the DMARC XML → upsert
 * dmarc_reports on report_id and replace its dmarc_records.
 *
 * Error handling: permanent faults (not a receipt, SES setup notice, virus
 * FAIL, oversized mail or attachment, bad MIME or XML) answer 200 so SNS does
 * not retry them; S3 and database errors answer 500 so SNS retries.
 *
 * The logic lives in app/lib/dmarc/sns-dmarc.ts; this file wires the I/O.
 */

import type { Route } from './+types/api.v1.webhooks.dmarc';
import { CONFIG } from '#config';
import { verifySnsMessage } from '#app/lib/sns/verifier';
import { createComponentLogger } from '#app/lib/logger';
import { openS3Object } from '#app/lib/s3-client';
import { handleDmarcSnsRequest } from '#app/lib/dmarc/sns-dmarc';
import { storeDmarcReport } from '#app/models/dmarc-reports.server';

const log = createComponentLogger('DmarcWebhookRoute');

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

  return handleDmarcSnsRequest({
    rawBody,
    deps: {
      topicArn: CONFIG.dmarc.snsTopicArn,
      log,
      verify: (envelope) => verifySnsMessage(envelope),
      confirmSubscription: async (subscribeUrl) => (await fetch(subscribeUrl)).ok,
      openObject: ({ bucket, key }) => openS3Object(bucket, key),
      storeReport: (input) => storeDmarcReport(input),
    },
  });
}
