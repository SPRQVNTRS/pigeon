/**
 * SES account level suppression list.
 *
 * SES keeps its own list of addresses it will not send to (bounces and
 * complaints). The list is per AWS account, so all apps share it. A recipient
 * erase drops the address there only when no app still holds a suppression for
 * it, and this module does not check that: the route decides before it calls
 * here (erase-suppression-decision in app/routes/api.v1.recipients.erase.tsx).
 */
import { DeleteSuppressedDestinationCommand } from '@aws-sdk/client-sesv2';
import { getSesClient } from './client';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('SesSuppression');

export type SesSuppressionOutcome = 'deleted' | 'not_found' | 'failed';

/**
 * Remove one address from the SES account level suppression list.
 *
 * Never throws and never logs the address. NotFoundException counts as
 * success, so the call is safe whether or not the account has the list on or
 * the address is on it. Any other error is logged by name and code and
 * reported as `failed`: the database erase is already done, and failing the
 * request would only make the caller retry a finished erase.
 */
export async function deleteSesSuppressedDestination(opts: {
  email: string;
}): Promise<SesSuppressionOutcome> {
  try {
    await getSesClient().send(new DeleteSuppressedDestinationCommand({ EmailAddress: opts.email }));
    return 'deleted';
  } catch (err) {
    const { name, Code } = err as { name?: string; Code?: string };
    if (name === 'NotFoundException') return 'not_found';

    log.error('SES suppression delete failed', {
      errorName: name ?? 'UnknownError',
      errorCode: Code ?? null,
    });
    return 'failed';
  }
}
