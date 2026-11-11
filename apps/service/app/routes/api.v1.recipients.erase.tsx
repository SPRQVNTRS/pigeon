/**
 * POST /v1/recipients/erase — erase one recipient address for the calling app
 *
 * Body: { "email": "<address>" }. The address is in the body, not the URL, so
 * no access log holds it. Scoped to the API key's app: other apps' records of
 * the same address stay.
 *
 * Always 204 when the body is valid and the erase ran: the same answer whether
 * or not the address was ever a recipient or a sender, and the same on a
 * second call. The response therefore does not reveal who was mailed. The
 * address is never logged.
 *
 * 500 when the erase fails, the database or the S3 delete of received mail
 * (app/lib/recipient-erase.ts). The S3 delete runs before the transaction, so
 * an S3 failure deletes nothing in the database and a retry starts over.
 *
 * erase-suppression-decision: the SES suppression list is per AWS account, so
 * all apps share it. After the transaction the route reads whether any row in
 * `suppressions` still holds the address, in any app, the calling app's kept
 * complaint included.
 *   - A row exists: SES is not called. Outcome `kept`.
 *   - No row: SES is called. Outcome `deleted`, `not_found` or `failed`.
 *   - The read fails: SES is not called. Outcome `failed`. The erase stays done.
 * The trade-off: the address stays on the shared SES list while another app
 * holds a suppression for it, because that app also holds the address. It goes
 * when the last one erases. The answer never reveals which case happened, and
 * only the outcome is logged.
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.recipients.erase';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { db } from '#drizzle/db';
import { eraseRecipientData, isAddressSuppressedInAnyApp } from '#app/lib/recipient-erase';
import { normalizeAddress } from '#app/lib/email-address';
import { deleteSesSuppressedDestination, type SesSuppressionOutcome } from '#app/lib/ses/suppression';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('RecipientsEraseRoute');

const EraseRecipientSchema = z.object({
  email: z.string().trim().email().max(320),
});

type SesEraseOutcome = SesSuppressionOutcome | 'kept';

/** See erase-suppression-decision above. Never throws. */
async function releaseSesBlockUnlessHeld(opts: { email: string }): Promise<SesEraseOutcome> {
  try {
    if (await isAddressSuppressedInAnyApp({ db, email: opts.email })) return 'kept';
  } catch (err) {
    log.error('Suppression read failed, SES left alone', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    });
    return 'failed';
  }
  return deleteSesSuppressedDestination({ email: opts.email });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
  }

  const { appId } = context.get(apiKeyContext)!;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }

  const parsed = EraseRecipientSchema.safeParse(rawBody);
  if (!parsed.success) {
    // Field errors name the field, never the value.
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }

  const email = normalizeAddress(parsed.data.email);

  try {
    await eraseRecipientData({ db, appId, email });
  } catch (err) {
    log.error('Recipient erase failed', { appId, errorName: err instanceof Error ? err.name : 'UnknownError' });
    return Response.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 });
  }

  // After the transaction: a failure here must not undo or fail the erase.
  const sesOutcome = await releaseSesBlockUnlessHeld({ email });
  log.info('Recipient erase finished', { appId, sesOutcome });

  return new Response(null, { status: 204 });
}
