/**
 * Retention limits of inbound mail data. No imports, so the AWS scripts can
 * read the S3 lifecycle value without loading the database layer. The list
 * of places and how each limit is enforced: ./retention.ts.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The limit every place below must stay within, task cadence included. */
export const INBOUND_HARD_LIMIT_MS = 7 * DAY_MS;

export const INBOUND_RETENTION_INTERVAL_MINUTES = 15;
export const INBOUND_RETENTION_CRON = `*/${INBOUND_RETENTION_INTERVAL_MINUTES} * * * *`;

/** inbound_emails rows: 7 days minus one hour, so the worst case stays under 7 days. */
export const INBOUND_EMAIL_ROW_RETENTION_MS = 7 * DAY_MS - HOUR_MS;

/** Finished jobs of the inbound queues. */
export const INBOUND_FINISHED_JOB_RETENTION_MS = HOUR_MS;

/** Any job of the inbound queues, whatever its state. */
export const INBOUND_JOB_MAX_AGE_MS = 2 * DAY_MS;

/** S3 lifecycle on incoming/: S3 expires at the next 00:00 UTC after N days, so N = 6 keeps it under 7 days. */
export const INBOUND_S3_EXPIRATION_DAYS = 6;
