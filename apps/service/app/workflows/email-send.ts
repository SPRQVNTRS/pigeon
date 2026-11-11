/**
 * email.send worker
 *
 * Processes queued email jobs: suppression check → SES send → status update.
 * Registered via boss.work() — same pattern as domain-verify.ts.
 */
import { db } from '#drizzle/db';
import { emails } from '#drizzle/schema';
import { eq, and } from 'drizzle-orm';
import { sendEmail } from '#app/lib/ses';
import { isSuppressed } from '#app/models/suppressions.server';
import { blankEmailBody, updateEmailStatus } from '#app/models/emails.server';
import { createComponentLogger } from '#app/lib/logger';
import { EMAIL_SEND_QUEUE } from '#app/lib/queue-names';

const log = createComponentLogger('EmailSendWorker');

interface EmailSendPayload {
  emailId: string;
  appId: string;
  domainId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  configurationSetName?: string;
  /**
   * false: keep no html, text or headers once the send is over. Absent means
   * true, so jobs queued before this field existed behave as before.
   */
  retainBody?: boolean;
}

interface EmailSendJob {
  id: string;
  data: EmailSendPayload;
  /** Present because the worker asks for metadata (see registerEmailSendWorker). */
  retryCount?: number;
  retryLimit?: number;
}

/**
 * Minimal interface for a pg-boss instance that supports work().
 * Compatible with pg-boss@10 and @12.
 */
export interface BossWorker {
  createQueue(name: string): Promise<void>;
  deleteJob(name: string, id: string): Promise<unknown>;
  work(
    name: string,
    options: { batchSize: number; includeMetadata: boolean },
    handler: (jobs: EmailSendJob[]) => Promise<void>,
  ): unknown;
}

/**
 * Register the email.send worker with the given pg-boss instance.
 * Creates the queue first (idempotent — pg-boss uses ON CONFLICT DO NOTHING).
 */
export async function registerEmailSendWorker(boss: BossWorker): Promise<void> {
  await boss.createQueue(EMAIL_SEND_QUEUE);
  // includeMetadata gives each job its retryCount and retryLimit, which the
  // handler needs to know whether a failed attempt is the last one.
  boss.work(EMAIL_SEND_QUEUE, { batchSize: 1, includeMetadata: true }, createEmailSendHandler(boss));
  log.info('email.send worker registered');
}

// SES error names that indicate permanent failure (no retry)
const PERMANENT_ERRORS = new Set([
  'MessageRejected',
  'InvalidParameterValue',
  'MailFromDomainNotVerifiedException',
  'SendingPausedException',
]);

/**
 * Build the pg-boss handler for email.send.
 *
 * A mail sent with `retain_body: false` must leave no body in Pigeon once its
 * send is over. Its body lives in two places, the `emails` row and the job
 * data in pg-boss, so when the job is over the handler blanks the row and
 * deletes the job. "Over" means: sent, skipped as suppressed, failed
 * permanently, found already handled, or failed on its last attempt. While a
 * retry is still coming, the job data is the only copy the retry can send, so
 * it stays.
 */
export function createEmailSendHandler(
  boss: Pick<BossWorker, 'deleteJob'>,
): (jobs: EmailSendJob[]) => Promise<void> {
  return async (jobs) => {
    const job = jobs[0];
    if (!job) return;

    try {
      await processEmailSend(job);
    } catch (err) {
      const isLastAttempt =
        job.retryCount !== undefined && job.retryLimit !== undefined && job.retryCount >= job.retryLimit;
      if (job.data.retainBody !== false || !isLastAttempt) throw err;

      // Last attempt of a mail that keeps no body: no retry will come, so
      // record the failure and let the body go instead of rethrowing into a
      // job that pg-boss would keep, data and all.
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('email.send: out of retries', { emailId: job.data.emailId });
      await updateEmailStatus(job.data.emailId, job.data.appId, 'failed', { failureReason: error.message });
    }

    await discardBodyUnlessRetained(boss, job);
  };
}

async function discardBodyUnlessRetained(boss: Pick<BossWorker, 'deleteJob'>, job: EmailSendJob): Promise<void> {
  if (job.data.retainBody !== false) return;

  await blankEmailBody(job.data.emailId, job.data.appId);
  // Deleting the active job is safe: pg-boss's completion UPDATE then matches
  // no row and does nothing.
  await boss.deleteJob(EMAIL_SEND_QUEUE, job.id);
  log.info('email.send: body discarded', { emailId: job.data.emailId });
}

/**
 * Send one queued email. Returns when the job is over, throws when it should
 * be retried.
 */
async function processEmailSend(job: EmailSendJob): Promise<void> {
  const { emailId, appId, from, to, cc, bcc, replyTo, subject, html, text, headers, configurationSetName } = job.data;

  // Verify email is still queued (avoid double-processing)
  const [emailRow] = await db.select().from(emails).where(and(eq(emails.id, emailId))).limit(1);
  if (!emailRow || emailRow.status !== 'queued') {
    log.info('email.send: skipping non-queued email', { emailId, status: emailRow?.status });
    return;
  }

  // Suppression check — filter recipients
  const allRecipients = [...to, ...(cc ?? []), ...(bcc ?? [])];
  const suppressedChecks = await Promise.all(allRecipients.map((r) => isSuppressed(appId, r)));
  const filteredTo = to.filter((_, i) => !suppressedChecks[i]);
  const filteredCc = (cc ?? []).filter((_, i) => !suppressedChecks[to.length + i]);
  const filteredBcc = (bcc ?? []).filter((_, i) => !suppressedChecks[to.length + (cc?.length ?? 0) + i]);

  if (filteredTo.length === 0) {
    log.info('All recipients suppressed, skipping', { emailId });
    await updateEmailStatus(emailId, appId, 'skipped_suppressed');
    return; // no throw — job completes successfully
  }

  try {
    const result = await sendEmail({
      from,
      to: filteredTo,
      cc: filteredCc.length > 0 ? filteredCc : undefined,
      bcc: filteredBcc.length > 0 ? filteredBcc : undefined,
      replyTo,
      subject,
      html,
      text,
      headers,
      configurationSet: configurationSetName,
    });

    await updateEmailStatus(emailId, appId, 'sent', {
      messageId: result.messageId,
      sentAt: new Date(),
    });

    log.info('Email sent', { emailId, messageId: result.messageId });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errorName = (err as { name?: string }).name ?? '';

    if (PERMANENT_ERRORS.has(errorName)) {
      log.error('Permanent SES error, marking failed', { emailId, errorName, message: error.message });
      await updateEmailStatus(emailId, appId, 'failed', { failureReason: error.message });
      return; // no throw — permanent failure doesn't retry
    }

    log.error('Transient SES error, will retry', { emailId, errorName, message: error.message });
    throw error; // pg-boss retries on throw
  }
}
