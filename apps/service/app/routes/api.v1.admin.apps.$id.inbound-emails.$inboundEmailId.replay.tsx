/**
 * POST /v1/admin/apps/:id/inbound-emails/:inboundEmailId/replay — queue
 * inbound.process again for a received mail. The worker reads the raw mail
 * from S3 and sends new deliveries with new delivery ids (the consumer
 * dedupes by Message-ID).
 *
 *   404 app_not_found / inbound_email_not_found  (the row expires after < 7 days)
 *   410 raw_mail_expired                          (the S3 object is gone)
 *   202 { inboundEmailId, jobId }
 *
 * Every response carries Cache-Control: no-store.
 * Protected by adminAuthMiddleware via _admin-api layout.
 */

import type { Route } from './+types/api.v1.admin.apps.$id.inbound-emails.$inboundEmailId.replay';
import { getAppById } from '#app/models/apps.server';
import { getInboundEmail } from '#app/models/inbound-emails.server';
import { s3ObjectExists } from '#app/lib/s3-client';
import { INBOUND_PROCESS_QUEUE } from '#app/lib/queue-names';
import { getOrchestrator } from '#app/services/workflows.server';
import { INBOUND_PROCESS_SEND_OPTIONS } from '#app/workflows/inbound-process';
import { apiError, noStoreJson } from '#app/lib/webhook-api';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('AdminInboundReplayRoute');

function methodNotAllowed(): Response {
  return apiError({
    status: 405,
    code: 'method_not_allowed',
    message: 'Method Not Allowed',
    headers: { Allow: 'POST' },
  });
}

export async function loader() {
  return methodNotAllowed();
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') return methodNotAllowed();

  const { id: appId, inboundEmailId } = params;

  try {
    const app = await getAppById(appId);
    if (!app) return apiError({ status: 404, code: 'app_not_found', message: 'App not found' });

    const email = await getInboundEmail({ appId, id: inboundEmailId });
    if (!email) {
      return apiError({ status: 404, code: 'inbound_email_not_found', message: 'Inbound email not found' });
    }

    if (!(await s3ObjectExists(email.s3Bucket, email.s3Key))) {
      return apiError({
        status: 410,
        code: 'raw_mail_expired',
        message: 'The raw mail is no longer stored, so it cannot be replayed',
      });
    }

    const jobId = await getOrchestrator()
      .getBoss()
      .send(INBOUND_PROCESS_QUEUE, { inboundEmailId, appId }, { ...INBOUND_PROCESS_SEND_OPTIONS });
    if (!jobId) throw new Error(`pg-boss refused the ${INBOUND_PROCESS_QUEUE} job`);

    log.info('Inbound email replay queued via admin API', { appId, inboundEmailId, jobId });
    return noStoreJson({ inboundEmailId, jobId }, { status: 202 });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to queue inbound email replay', { appId, inboundEmailId, error });
    return apiError({ status: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
