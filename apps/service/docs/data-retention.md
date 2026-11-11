# Data retention and recipient erase

Pigeon holds recipient addresses and mail bodies. This page says where, for how long, and how to remove them. Pigeon serves several products, so nothing here deletes anything by default.

## Where the data sits

| Place | What it holds |
| --- | --- |
| `emails` | recipients (`to_addresses`, `cc_addresses`, `bcc_addresses`, `reply_to`), `subject`, `html`, `text`, `headers` |
| `email_events` | `raw`, the whole SES notification, which holds the recipient address |
| `idempotent_requests` | the key, when a consumer builds it from the address. The hourly cleanup removes it after 25 hours, and an erase does not touch it |
| `suppressions` | address and reason, written on a hard bounce or a complaint |
| `contacts` | address, names, attributes, in the app's audiences |
| `pgboss.job` | one `email.send` job per mail, with the full payload in `data`; `webhook.deliver` and `ses.event.process` jobs carry the recipient and the SES notification |
| `pgboss.archive` | a full copy of a finished job, `data` included (pg-boss 10 only) |
| `inbound_emails` | one row per received mail: the matched recipients on the tenant's inbound domain, and a keyed hash of the sender (never the sender address) |
| S3 `<inbound bucket>/incoming/` (`PIGEON_INBOUND_BUCKET`) | the raw received mail: sender, subject, body |
| SES account suppression list | the address, after a bounce or complaint |

## Per-app retention (off by default)

Two nullable columns on `apps`. `NULL` means keep forever, which is how Pigeon behaved before retention existed. Nothing changes for an app until someone sets a value.

| Column | Effect once the limit passes (measured from `emails.created_at`) |
| --- | --- |
| `mail_body_retention_days` | `html` and `text` become `NULL`, `headers` becomes `{}`. The row stays. |
| `mail_row_retention_days` | the `emails` row and its `email_events` are deleted. Events are also deleted by their own `received_at`. |

Both must be positive when set (CHECK constraint). Set them in SQL, for example for one app:

```sql
UPDATE apps SET mail_body_retention_days = 7, mail_row_retention_days = 30 WHERE id = '<app id>';
```

The scheduled task `mail-retention` (`app/scheduled-tasks/handlers/mail-retention.ts`, logic in `app/lib/mail-retention.ts`) runs daily at 03:30 UTC. It logs counts only, never an address or a subject. There is no admin API for the two columns yet.

## Per-mail flag: `retain_body: false`

`POST /v1/emails` accepts an optional boolean `retain_body`, default `true`. With `false`, Pigeon keeps no body once the send is over:

- The `emails` row has `html`, `text` and `headers` blanked.
- The `email.send` job is deleted from pg-boss.

"Over" means SES accepted it, every recipient was suppressed, SES failed it for good, or the last retry failed. While a retry is still coming, the job data is the only copy the retry can send, so it stays. Recipients, subject and status stay on the row. The field name is snake_case, unlike `replyTo` in the same body.

## Recipient erase

```
POST /v1/recipients/erase
Authorization: Bearer <api key>
Content-Type: application/json

{ "email": "person@example.com" }
```

- `204` with no body: always when the erase ran, also when the address was never a recipient, also on a second call. The answer does not reveal who was mailed.
- `400`: the body is not JSON, or `email` is missing or not an address.
- `401`: bad or missing API key. `500`: the database step or the S3 delete of received mail failed. Nothing in the database was erased (one transaction, after the S3 step), so retry.

Scope: the app of the API key. Another app's records of the same address stay. The address is matched case insensitively and is never logged.

First, outside the transaction: the raw received mail in S3 of each `inbound_emails` row of the app whose sender hash matches the address. No matching row means no S3 call. An S3 failure stops the erase before the transaction. See "Recipient erase" in `docs/inbound-mail.md`.

Then in one transaction, in order:

1. `email_events` of the matching emails.
2. `emails` where the address is in `to`, `cc`, `bcc`, or is the `reply_to`. A row with several recipients is deleted whole.
3. `contacts` with the address, in the app's audiences.
4. `suppressions` for the app and address, **except** a `complaint`. A complaint stays so the address keeps being blocked. This is a recorded decision.
5. `email.send` jobs of the app that carry the address, in `pgboss.job` and, when the table exists, `pgboss.archive`.
6. Inbound jobs of the app for mail from the address: `webhook.deliver.inbound` deliveries whose sender is the address, and `inbound.process` jobs of the matching rows. Same two tables.
7. `inbound_emails` rows of the app whose sender hash matches the address.

After the transaction, Pigeon checks if any row in `suppressions` still holds the address, in any app. The calling app's kept complaint row counts. Matching is case-insensitive, like the erase.

- A row exists: SES is not called. The log outcome is `kept`.
- No row: Pigeon calls SESv2 `DeleteSuppressedDestination` for the address. The log outcome is `deleted`, or `not_found` on a `NotFoundException` (which counts as success). Any other SES error logs by name and code, and the outcome is `failed`. The runtime IAM user needs `ses:DeleteSuppressedDestination` for this call (statement `EraseSuppression` in `scripts/lib/runtime-policy.ts`). Without it, SES returns `AccessDeniedException`, the log records it, and the address stays on the SES suppression list.
- The read fails: SES is not called. Pigeon logs the error by name only, and the outcome is `failed`. The erase remains complete. A later erase call for the address retries the SES step.

The response is `204` in all three cases and exposes none of these details. The log records the outcome, never the address.

Recorded decision, `erase-suppression-decision`: the SES suppression list is per AWS account, so all apps share it. One app's erase must not clear a block created by another app's bounce or complaint, nor clear a block from its own kept complaint. The trade-off: the address stays on the shared SES list while another app suppresses it, because that app also stores the address. It clears only when the last app erases it. A complaint row is never erased, so an address with a complaint stays on the SES list.

Not covered: `webhook.deliver` and `ses.event.process` job rows are not matched by address (the first is scoped by webhook, the second is not scoped to an app). They age out through the job pruning below. The nightly database backup is outside Pigeon.

The list of stores is `ERASE_STORES` in `app/lib/recipient-erase.ts`. The tests (`test/recipient-erase.test.ts`) run from the same list, so a store without a test fixture fails.

## pg-boss retention

**Which pg-boss runs.** `package.json` lists pg-boss 12.15.0, but the orchestrator is built inside `@sprqvntrs/workflows`, which pins **pg-boss 10.4.2**. That is the boss that runs the queues (`pnpm why pg-boss` shows both). The orchestrator passes no retention options, so these 10.4.2 defaults apply (from `node_modules/.pnpm/pg-boss@10.4.2/node_modules/pg-boss/src/attorney.js` and `@sprqvntrs/workflows/src/infrastructure/pg-boss.ts`):

| Setting | Value | Meaning |
| --- | --- | --- |
| `archiveCompletedAfterSeconds` | 604800 (7 days) | a finished job is moved from `job` to `archive` after this |
| `deleteAfter` | 7 days | a row in `archive` is deleted this long after `archived_on` |
| `retentionMinutes` | 10080 (7 days) | a waiting (created or retry) job is deleted after this |

So a mail body sat in Postgres about 14 days after the send, in two tables. In pg-boss 10 these are options of the whole boss, not of a queue, and Pigeon cannot set them through the orchestrator.

**What Pigeon does.** The scheduled task `queue-job-retention` (hourly) deletes finished jobs (`completed`, `failed`, `cancelled`) of `email.send`, `webhook.deliver` and `ses.event.process` one day after `completed_on`, from `pgboss.job` and from `pgboss.archive`. One day is long enough to look at a failure and retry it from the admin jobs page. It leaves waiting, retrying and active jobs alone, and it does not touch retry settings or any other queue.

**pg-boss 12, for the day it replaces 10.** Its defaults are `retentionSeconds` 14 days (waiting jobs) and `deleteAfterSeconds` 7 days (finished jobs, per queue, copied onto each job at insert). It has no archive table, so the archive step of the pruning is skipped when the table is absent. If the orchestrator ever passes queue options through, set `deleteAfterSeconds: 86400` on the three queues and remember `createQueue` ignores options for a queue that already exists (use `updateQueue`).

Jobs finished before the pruning task first ran are caught by its first run.
