/**
 * Erase one recipient address from everything Pigeon stores for one app.
 *
 * The work is a list of stores, one entry per place an address can sit. The
 * route runs the whole list in one transaction, and the tests drive from the
 * same list, so a store added here without a check there fails the suite and a
 * store dropped from the list fails its check.
 *
 * Everything is scoped to `appId`, the app of the calling API key. Another
 * product's mail to the same address stays: Pigeon serves several products and
 * one product's erase request is no reason to delete another's records.
 *
 * Received mail (inbound) counts too: the person who replies to a tenant is
 * the data subject. inbound.process stores a keyed hash of the From address on
 * the inbound_emails row (app/lib/inbound/sender-hash.ts); the inbound stores
 * below and the S3 step in eraseRecipientData find the mail through it.
 *
 * Logs and returns counts only. The address never appears in a log line.
 */
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  audiences,
  contacts,
  emailEvents,
  emails,
  inboundEmails,
  suppressions,
  webhooks,
} from '#drizzle/schema/index';
import type { Database, Transaction } from '#app/lib/db-types';
import { normalizeAddress } from '#app/lib/email-address';
import { inboundSenderHash } from '#app/lib/inbound/sender-hash';
import { createComponentLogger } from '#app/lib/logger';
import { PGBOSS_SCHEMA } from '#app/lib/queue-job-retention';
import { EMAIL_SEND_QUEUE, INBOUND_PROCESS_QUEUE, WEBHOOK_DELIVER_INBOUND_QUEUE } from '#app/lib/queue-names';
import { deleteS3Object } from '#app/lib/s3-client';

const log = createComponentLogger('RecipientErase');

/** The suppression reason that must survive an erase. See the suppressions store. */
export const COMPLAINT_REASON = 'complaint';

export interface EraseStore {
  readonly name: string;
  /** Delete this store's rows for the address. Returns how many rows went. */
  erase(opts: { tx: Transaction; appId: string; address: string }): Promise<number>;
}

/**
 * SQL condition on `emails`: the address is a recipient (to, cc, bcc) or the
 * reply-to, case insensitive. `address` must already be lowercase.
 */
function emailRowHasAddress(address: string): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM unnest(${emails.toAddresses}) AS a WHERE lower(a) = ${address})
    OR EXISTS (SELECT 1 FROM unnest(${emails.ccAddresses}) AS a WHERE lower(a) = ${address})
    OR EXISTS (SELECT 1 FROM unnest(${emails.bccAddresses}) AS a WHERE lower(a) = ${address})
    OR lower(${emails.replyTo}) = ${address}
  )`;
}

/**
 * SQL condition on a pg-boss job row: an email.send job of this app whose data
 * carries the address as to, cc, bcc or replyTo. The payload is built in
 * app/routes/api.v1.emails.tsx.
 */
function jobCarriesAddress(opts: { appId: string; address: string }): SQL {
  const { appId, address } = opts;
  // `key` is one of three constants, never input, so it is safe to inline.
  const inList = (key: 'to' | 'cc' | 'bcc'): SQL => {
    const field = sql.raw(`data->'${key}'`);
    return sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(${field}) = 'array' THEN ${field} ELSE '[]'::jsonb END
      ) AS a WHERE lower(a) = ${address}
    )`;
  };
  return sql`(
    data->>'appId' = ${appId}
    AND (${inList('to')} OR ${inList('cc')} OR ${inList('bcc')} OR lower(data->>'replyTo') = ${address})
  )`;
}

/**
 * SQL condition on a pg-boss job row: an inbound job of this app that carries
 * the sender's mail.
 *   - webhook.deliver.inbound: the `email.received` payload's `data.from` is
 *     the address (app/lib/inbound/payload.ts). The job is this app's when its
 *     webhook is, or when the payload names the app as organization_id
 *     (app/lib/webhook-fanout.ts sets it), which still holds after the webhook
 *     is deleted and its jobs stay behind for retries.
 *   - inbound.process: carries only ids, so it matches through this app's
 *     inbound_emails rows with the sender hash. Those rows must still exist,
 *     so this store runs before the inbound_emails store.
 */
function inboundJobCarriesSender(opts: { appId: string; address: string }): SQL {
  const { appId, address } = opts;
  const senderHash = inboundSenderHash(address);
  return sql`(
    (
      name = ${WEBHOOK_DELIVER_INBOUND_QUEUE}
      AND lower(btrim(data->'payload'->'data'->>'from')) = ${address}
      AND (
        data->>'webhookId' IN (SELECT ${webhooks.id} FROM ${webhooks} WHERE ${webhooks.appId} = ${appId})
        OR data->'payload'->>'organization_id' = ${appId}
      )
    )
    OR (
      name = ${INBOUND_PROCESS_QUEUE}
      AND data->>'appId' = ${appId}
      AND data->>'inboundEmailId' IN (
        SELECT ${inboundEmails.id} FROM ${inboundEmails}
        WHERE ${inboundEmails.appId} = ${appId} AND ${inboundEmails.senderHash} = ${senderHash}
      )
    )
  )`;
}

/**
 * Delete matching rows from pgboss.job, and from pgboss.archive when it exists.
 * pg-boss 10 moves a finished job to pgboss.archive, pg-boss 12 has no archive
 * table.
 */
async function deleteJobs(opts: { tx: Transaction; match: SQL }): Promise<number> {
  const { tx, match } = opts;
  const jobs = await tx.execute(sql`DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.job WHERE ${match}`);
  if (!(await pgbossTableExists({ tx, table: 'archive' }))) return jobs.rowCount ?? 0;
  const archived = await tx.execute(sql`DELETE FROM ${sql.identifier(PGBOSS_SCHEMA)}.archive WHERE ${match}`);
  return (jobs.rowCount ?? 0) + (archived.rowCount ?? 0);
}

async function pgbossTableExists(opts: { tx: Transaction; table: string }): Promise<boolean> {
  const { rows } = await opts.tx.execute<{ present: boolean }>(
    sql`SELECT to_regclass(${`${PGBOSS_SCHEMA}.${opts.table}`}) IS NOT NULL AS present`,
  );
  return rows[0]?.present === true;
}

/**
 * Order matters twice: email_events goes before emails, and inbound_queue_jobs
 * before inbound_emails, because each finds its rows through rows of the
 * other that still exist.
 */
export const ERASE_STORES = [
  {
    // The SES notification copy (raw) of every mail to the address.
    name: 'email_events',
    async erase({ tx, appId, address }) {
      const rows = await tx
        .delete(emailEvents)
        .where(
          and(
            eq(emailEvents.appId, appId),
            inArray(
              emailEvents.emailId,
              tx
                .select({ id: emails.id })
                .from(emails)
                .where(and(eq(emails.appId, appId), emailRowHasAddress(address))),
            ),
          ),
        )
        .returning({ id: emailEvents.id });
      return rows.length;
    },
  },
  {
    // A row with several recipients is deleted whole, not edited down to the
    // other recipients: the subject, body and status describe a mail that went
    // to all of them, and an edited row would be a record that never existed.
    // A consumer that sends each mail to exactly one recipient sees this as
    // the same as removing one person's mail.
    name: 'emails',
    async erase({ tx, appId, address }) {
      const rows = await tx
        .delete(emails)
        .where(and(eq(emails.appId, appId), emailRowHasAddress(address)))
        .returning({ id: emails.id });
      return rows.length;
    },
  },
  {
    // Contacts hang off audiences, so match on the app's audiences as well as
    // on contacts.app_id.
    name: 'contacts',
    async erase({ tx, appId, address }) {
      const rows = await tx
        .delete(contacts)
        .where(
          and(
            eq(contacts.appId, appId),
            eq(contacts.email, address),
            inArray(
              contacts.audienceId,
              tx.select({ id: audiences.id }).from(audiences).where(eq(audiences.appId, appId)),
            ),
          ),
        )
        .returning({ id: contacts.id });
      return rows.length;
    },
  },
  {
    // RECORDED DECISION: a complaint suppression is kept. A person who marked
    // our mail as spam must keep being blocked after they ask us to forget
    // them, or the next send to that address risks the SES sending reputation.
    // Every other reason (hard bounce) is erased. This is the one place an
    // erase leaves the address behind in this app's rows, and it is on purpose.
    // The shared SES list is a separate call, see erase-suppression-decision in
    // app/routes/api.v1.recipients.erase.tsx.
    name: 'suppressions',
    async erase({ tx, appId, address }) {
      const rows = await tx
        .delete(suppressions)
        .where(
          and(
            eq(suppressions.appId, appId),
            eq(suppressions.email, address),
            ne(suppressions.reason, COMPLAINT_REASON),
          ),
        )
        .returning({ id: suppressions.id });
      return rows.length;
    },
  },
  {
    // The email.send job holds a second copy of the body and recipients.
    // Covers job and archive, see deleteJobs.
    name: 'queue_jobs',
    async erase({ tx, appId, address }) {
      const match = sql`name = ${EMAIL_SEND_QUEUE} AND ${jobCarriesAddress({ appId, address })}`;
      return deleteJobs({ tx, match });
    },
  },
  {
    // Received mail from the address: the email.received deliveries (sender,
    // subject, body) and the inbound.process jobs of the sender's rows.
    // Must run before inbound_emails, see inboundJobCarriesSender.
    name: 'inbound_queue_jobs',
    async erase({ tx, appId, address }) {
      return deleteJobs({ tx, match: inboundJobCarriesSender({ appId, address }) });
    },
  },
  {
    // The row of each mail the address sent to this app, found by the keyed
    // sender hash. Its raw mail in S3 goes first, outside the transaction, see
    // eraseRecipientData.
    name: 'inbound_emails',
    async erase({ tx, appId, address }) {
      const rows = await tx
        .delete(inboundEmails)
        .where(and(eq(inboundEmails.appId, appId), eq(inboundEmails.senderHash, inboundSenderHash(address))))
        .returning({ id: inboundEmails.id });
      return rows.length;
    },
  },
] as const satisfies readonly EraseStore[];

export type EraseStoreName = (typeof ERASE_STORES)[number]['name'];

export type EraseCounts = Record<EraseStoreName, number>;

/**
 * Does any app still hold a suppression for this address? The one read in this
 * module that is not scoped to an app, on purpose: the SES suppression list is
 * shared by all apps, so the route needs to know about all of them before it
 * touches that list (erase-suppression-decision in
 * app/routes/api.v1.recipients.erase.tsx). It answers a yes or no and nothing
 * else, so no other app's row can reach a caller.
 *
 * `suppressions.email` is citext, so the match is case insensitive, the same as
 * the erase. Throws when the read fails: the caller decides what that means.
 */
export async function isAddressSuppressedInAnyApp(opts: { db: Database; email: string }): Promise<boolean> {
  const rows = await opts.db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalizeAddress(opts.email)))
    .limit(1);
  return rows.length > 0;
}

/** Count key of the S3 step in the result of eraseRecipientData. */
export const INBOUND_RAW_MAIL_COUNT = 'inbound_raw_mail';

export type DeleteRawMail = (opts: { bucket: string; key: string }) => Promise<void>;

/**
 * Delete the raw mail in S3 of every inbound_emails row of this app with the
 * sender's hash. Runs before the transaction: S3 is not part of it, so the
 * rows must outlive the objects. Any S3 error throws, the transaction never
 * starts and nothing in the database is deleted; a retry finds the same rows
 * and deletes again (S3 answers success for a key already gone). No matching
 * row means no S3 call at all.
 */
async function deleteInboundRawMail(opts: {
  db: Database;
  appId: string;
  address: string;
  deleteRawMail: DeleteRawMail;
}): Promise<number> {
  const { db, appId, address } = opts;
  const objects = await db
    .select({ bucket: inboundEmails.s3Bucket, key: inboundEmails.s3Key })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.appId, appId), eq(inboundEmails.senderHash, inboundSenderHash(address))));
  for (const object of objects) {
    await opts.deleteRawMail(object);
  }
  return objects.length;
}

/**
 * Delete the raw inbound mail in S3, then run the stores in one transaction:
 * all of them or none. Idempotent, and answers the same whether or not the
 * address was ever a recipient or a sender.
 *
 * `stores` exists so the tests can run the list with one store left out, and
 * `deleteRawMail` so they can stub S3.
 */
export async function eraseRecipientData(opts: {
  db: Database;
  appId: string;
  email: string;
  stores?: readonly EraseStore[];
  deleteRawMail?: DeleteRawMail;
}): Promise<Record<string, number>> {
  const { db, appId, stores = ERASE_STORES, deleteRawMail = deleteS3Object } = opts;
  const address = normalizeAddress(opts.email);

  const rawMailDeleted = await deleteInboundRawMail({ db, appId, address, deleteRawMail });

  const counts = await db.transaction(async (tx) => {
    const result: Record<string, number> = { [INBOUND_RAW_MAIL_COUNT]: rawMailDeleted };
    for (const store of stores) {
      result[store.name] = await store.erase({ tx, appId, address });
    }
    return result;
  });

  log.info('Recipient erased from Pigeon stores', { appId, ...counts });
  return counts;
}
