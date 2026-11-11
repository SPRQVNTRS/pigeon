# Pigeon Service: `apps/service`

## Schema Layout

All table definitions live under `drizzle/schema/`:

| File | Tables |
|------|--------|
| `users.ts` | `users` + re-exports workflow tables from `@sprqvntrs/workflows` |
| `apps.ts` | `apps`: anchor for `app_id` values |
| `api-keys.ts` | `api_keys`: per-app API keys (hashed, prefixed) |
| `domains.ts` | `domains`: SES-registered sending domains per app |
| `emails.ts` | `emails`: outbound email records |
| `email-events.ts` | `email_events`: delivery/bounce/open events from SES |
| `audiences.ts` | `audiences`: contact lists |
| `contacts.ts` | `contacts`: per-audience subscriber records |
| `suppressions.ts` | `suppressions`: global per-app unsubscribe/bounce list |
| `webhooks.ts` | `webhooks`: outbound webhook endpoints |
| `idempotent-requests.ts` | `idempotent_requests`: deduplication cache |
| `inbound.ts` | `inbound_domains`: tenant domains that receive mail through SES; `inbound_emails`: one row per received mail per domain (ids, S3 location, recipients, verdicts, a keyed hash of the sender; no sender address, subject or body) |

The barrel export is `drizzle/schema/index.ts`. The file `drizzle/schema.ts` re-exports from it for backward compatibility.

## app_id Scoping Contract

Every tenant-scoped table carries an `app_id TEXT NOT NULL` column. All model functions in `app/models/*.server.ts` **MUST** filter by `eq(table.appId, appId)` on every read and write. Forgetting this allows cross-tenant data access.

## ⚠️ Direct DB Access Risk

psql, Drizzle Studio, and raw SQL migrations **bypass `app_id` isolation entirely**. Anyone with direct database credentials can read or modify any tenant's data. Access to the Postgres instance must be restricted to:
- Service account credentials in environment variables
- Admin operations through the CLI with explicit app scoping

Never expose the database port publicly. Use SSH tunnels or VPN for maintenance access.

## Idempotency Cleanup

`idempotent_requests` rows expire after 25 hours. A pg-boss scheduled job (`idempotency-cleanup`, runs hourly) deletes rows where `created_at < now() - interval '25 hours'`. Handler: `app/scheduled-tasks/handlers/idempotency-cleanup.ts`.

## contacts.attributes

The `contacts.attributes` column is intentionally untyped `jsonb`. It stores arbitrary per-contact metadata supplied by the API caller. The service does not validate or index its contents.

## contacts Status vs. Suppressions

These are two distinct concepts:

- **contacts.status** tracks per-audience subscription state (`subscribed`, `unsubscribed`). A contact can be unsubscribed from one audience but remain subscribed in another.
- **suppressions** are global per-app blocks. A suppressed email address will never receive mail from any audience in that app, regardless of contact status. Suppressions are created automatically on hard bounces and spam complaints.

When sending, always check `suppressions` first. If suppressed, skip, do not check contact status.

## AWS IAM Permissions Required (SES)

The IAM user/role running the pigeon service needs the following permissions. All are scoped to `*` unless a more restrictive resource ARN is known at deploy time. `<inbound-bucket>`, `<config-set>` and `<region>` are placeholders: the real names come from env and config. The source of truth for the policy is `scripts/lib/runtime-policy.ts`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SESIdentityManagement",
      "Effect": "Allow",
      "Action": [
        "ses:CreateEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:PutEmailIdentityDkimSigningAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SESSendEmail",
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EraseSuppression",
      "Effect": "Allow",
      "Action": [
        "ses:DeleteSuppressedDestination"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ReadInboundMail",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::<inbound-bucket>/incoming/*"
    },
    {
      "Sid": "DeleteInboundMail",
      "Effect": "Allow",
      "Action": [
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::<inbound-bucket>/incoming/*"
    },
    {
      "Sid": "SESConfigSet",
      "Effect": "Allow",
      "Action": [
        "ses:GetConfigurationSet",
        "ses:GetConfigurationSetEventDestinations"
      ],
      "Resource": "arn:aws:ses:<region>:*:configuration-set/<config-set>"
    }
  ]
}
```

**Notes:**
- `PutEmailIdentityDkimSigningAttributes` is required to enable EasyDKIM (not `PutEmailIdentityDkimAttributes`).
- `SendEmail` is needed for raw MIME sends (`Content: { Raw: { Data } }`).
- `DeleteSuppressedDestination` is needed by the recipient erase route (`POST /v1/recipients/erase`). Without it SES answers `AccessDeniedException` and the address stays on the SES account-level suppression list. The source of truth is `scripts/lib/runtime-policy.ts`.
- `s3:GetObject` on `<inbound-bucket>/incoming/*` is needed by the inbound mail worker (`inbound.process`) and the replay route (HeadObject). Without it every received mail fails its S3 read and is retried, then dropped. Apply it with `pnpm setup:aws:inbound -- --update-runtime-policy --apply`.
- `s3:DeleteObject` on `<inbound-bucket>/incoming/*` (statement `DeleteInboundMail`) is needed by the recipient erase route. It deletes the raw mail a sender sent to the app. Without it an erase for an address with received mail answers 500 and deletes nothing. Apply it the same way.
- The configuration set (`<config-set>`) must exist before sends work; `pnpm setup:aws` creates it.
- Production access to SES (out of sandbox) must be granted on the AWS account before real recipients receive mail. See `docs/setup.md`.

## SES Module (`app/lib/ses/`)

| File | Purpose |
|------|---------|
| `client.ts` | Singleton `SESv2Client` per region (lazy-created, cached in `Map`) |
| `identity.ts` | `createIdentity`, `getIdentity`, `deleteIdentity`: EasyDKIM setup |
| `send.ts` | `sendEmail`: MIME assembly via nodemailer → `SendEmailCommand` |
| `dns.ts` | `buildDnsRecords`, a pure function that builds CNAME/SPF/DMARC/MX records. The DMARC value comes from `dmarc-record.ts`; it has a `rua` tag only while `PIGEON_DMARC_RUA` is set |
| `index.ts` | Barrel export |

### EasyDKIM flow

1. `CreateEmailIdentityCommand`: registers the domain with SES.
2. `PutEmailIdentityDkimSigningAttributesCommand` with `SigningAttributesOrigin: 'AWS_SES'`: enables EasyDKIM.
3. `GetEmailIdentityCommand`: fetches `DkimAttributes.Tokens` (three token strings).
4. Tokens are stored in `domains.dkim_tokens text[]` and returned to the caller as CNAME DNS records.
5. A `domain.verify` pg-boss job polls `GetEmailIdentity` until `DkimAttributes.Status === 'SUCCESS'`.

## Inbound Mail (`email.received`)

SES receives mail for a tenant's inbound domain (e.g. a reply domain), stores
it in S3 (`<inbound-bucket>/incoming/<stage>/`) and notifies the SNS
topic `pigeon-inbound-<stage>`. `POST /v1/webhooks/inbound` accepts only that
topic (`INBOUND_SNS_TOPIC_ARN`; unset means 503), writes one `inbound_emails`
row per matched domain and queues `inbound.process`. The worker streams the
raw mail from S3, parses it with bounded memory and fans out one signed
`email.received` delivery per recipient on `webhook.deliver.inbound`, a queue
of its own so junk bursts never delay bounce/complaint deliveries.

- Code: `app/lib/inbound/`, `app/workflows/inbound-process.ts`, the route
  `app/routes/api.v1.webhooks.inbound.tsx`, admin routes `api.v1.admin.apps.$id.inbound-*`.
- AWS: `scripts/aws-inbound.ts` (dry run by default, `--apply` to act).
- Sender authentication: `from` is not proof. The event carries `from_authenticated` (receipt DMARC PASS, or receipt DKIM/SPF PASS with a domain from the first SES Authentication-Results header aligned to From; `app/lib/inbound/authentication.ts`, "Sender authentication" in `docs/inbound-mail.md`).
- Privacy: the body, sender, recipients and subject never go into a log line,
  a thrown error or a table column, except `inbound_emails.recipients` (kept
  for replay). The row holds a keyed hash of the sender
  (`inbound_emails.sender_hash`, `app/lib/inbound/sender-hash.ts`), never the
  address, so the recipient erase can find a sender's mail. See "Recipient
  erase" in `docs/inbound-mail.md`. Every place that holds them has a limit under 7 days:
  `app/lib/inbound/retention.ts` lists them, the `inbound-retention` task
  (every 15 minutes) enforces them.
