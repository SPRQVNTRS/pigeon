# Setup guide

End-to-end operational flows for standing up pigeon and onboarding new consumers. Pair this with [ses-mechanics.md](./ses-mechanics.md) for the conceptual background.

Two flows:

1. [Initial setup](#1-initial-setup) — per AWS account, per stage. Done once.
2. [Adding a new consumer](#2-adding-a-new-consumer), onboard a new app with its own API key and sending domain.

The deployment substrate (container runtime, reverse proxy, secret store) is operator data and not part of this repo.

---

## 1. Initial setup

Run once per stage (`dev` / `staging` / `prod`). The stages are fully independent AWS environments.

### Prerequisites

- Admin AWS credentials for the target account (via `AWS_PROFILE=<admin-profile>` or ambient SDK credentials)
- Pigeon deployed and healthy, or running locally (see [local-e2e.md](./local-e2e.md))
- A public HTTPS endpoint reachable by AWS SNS for webhooks (in prod: `https://pigeon.example.com`; in dev: a cloudflared tunnel)

### Step 1 — Bootstrap AWS resources

`setup:aws` creates the SNS topic, SES configuration set, event destinations, runtime IAM user, and access key. Idempotent — safe to re-run. See [`scripts/README.md`](../scripts/README.md) for the full reference.

```bash
AWS_REGION=eu-central-1 STAGE=prod \
  WEBHOOK_ENDPOINT_URL=https://pigeon.example.com/v1/webhooks/ses \
  pnpm --filter @sprqvntrs/pigeon setup:aws
```

Captures:

- Access key `AWS_ACCESS_KEY_ID` + secret (printed once)
- SNS topic ARN
- Config set name (e.g. `pigeon-prod`)

Store these in your secret store and pass them to the service as the environment variables `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `SES_SNS_TOPIC_ARN` (see `.env.example`).

Redeploy so the service picks them up.

### Step 2 — Confirm SNS subscription

`setup:aws` created an SNS subscription pointing at the webhook endpoint but AWS requires confirmation via a handshake POST. The running service receives the handshake automatically and confirms it.

Verify:

```bash
aws --profile <admin-profile> --region eu-central-1 \
  sns list-subscriptions-by-topic \
  --topic-arn <topic-arn> \
  --query 'Subscriptions[].{ep:Endpoint,status:SubscriptionArn}'
```

`status` should be an ARN (not `PendingConfirmation`). If it's stuck pending, re-trigger a `setup:aws` run — it'll re-send the handshake.

### Step 3 — Request SES production access

**Required before real users can receive mail.** Until production access is granted, SES runs in sandbox mode and refuses to deliver mail to any recipient not pre-verified. That's incompatible with the "send to your users" use case.

**Scope:** production access is granted **per AWS account per region**, not per domain. Once account `<aws-account-id>` is approved in `eu-central-1`, every domain later verified in that account+region sends to real recipients without any further approval. Onboarding any future consumer requires **no repeat** of this step, just register the domain (see flow 2 below) and send.

Console path: SES → "Account dashboard" → "Request production access" (or the top banner when in sandbox mode).

Form values (replace the placeholders with your own):

| Field | Value |
|-------|-------|
| **Mail type** | Transactional |
| **Website URL** | `https://example.com` (+ consumer apps: `https://app.example.com`) |
| **Use case description** | See below |
| **Additional contact addresses** | `ops@example.com` |
| **Preferred contact language** | English |

Use case description (paste into the textarea — tweak wording as needed):

> <Your organization> operates a small portfolio of self-hosted web applications. We've built a shared transactional email service on top of AWS SES that powers our apps (<your-app-domains>) with signup confirmations, password resets, account notifications, and opt-in newsletter digests. All recipients are either (a) registered users of our applications who have provided their email during signup, or (b) newsletter subscribers who have completed double opt-in confirmation and hold an active unsubscribe link in every sent message. Volume is low, well under 10k sends per day across all consumers. We handle bounces and complaints via SNS event destinations that flow into our service database; hard bounces and complaints are added to a suppression list and the address is never contacted again. We DKIM-sign every outbound message, publish SPF and DMARC (starting at `p=none` and escalating to `p=quarantine`/`p=reject` after monitoring), and enforce a one-click unsubscribe link on marketing mail (RFC 8058). We have no acquired mailing lists and never send unsolicited mail.

AWS review is typically ~24h. Expect one or two clarification emails — answer promptly, the review cycle is fast if the answers cover all the points above.

While waiting, you can still smoke-test using sandbox-verified recipients (see Step 6).

### Step 4 — Bootstrap the first app + admin user

The service is multi-tenant. Every consumer talks to it through an organization / app boundary. On a fresh database, no apps exist yet — bootstrap the first one.

```bash
# With PIGEON_ADMIN_URL and PIGEON_ADMIN_SECRET set in .env (the admin CLI is `pnpm --silent pigeon`,
# run from the repo root, see packages/cli/README.md):
pnpm --silent pigeon apps create "<app-name>"
# Copy the app ID from the output, then:
pnpm --silent pigeon keys create <app-id> --name "prod"
# Store the printed key (shown once) in your secret store
```

Captures:

- App id (from `apps create` output)
- API key (`ske_...`) — printed once by `api-keys create`

**Store the API key in your secret store** (for consumer services to use), under a consumer-specific name if per-tenant.

### Step 5 — Register the sending domain

```bash
curl -X POST https://pigeon.example.com/v1/domains \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name": "example.com"}'
```

Returns the three DKIM tokens, an SPF TXT, a DMARC TXT, and an MX record. (If you're registering a domain that already receives mail elsewhere, see [Coexisting with an existing mail provider](#coexisting-with-an-existing-mail-provider-google-workspace-etc) below, the SPF record must be merged, not pasted verbatim, and the MX should be skipped.) See [ses-mechanics.md](./ses-mechanics.md) for the record shape.

Wait for SES verification (5–30 min typical). Monitor:

```bash
aws --profile <admin-profile> --region eu-central-1 \
  sesv2 get-email-identity --email-identity example.com \
  --query '{status:VerificationStatus,dkim:DkimAttributes.Status}'
```

When `status = SUCCESS`, the domain-verify worker flips the DB row to `dkim_status=verified`.

### Step 6 — Smoke test

Once the domain is verified, send one test email through the full pipeline and confirm inbox delivery + DKIM/SPF/DMARC headers.

**While in sandbox:** the recipient must be a verified SES identity first:

```bash
aws --profile <admin-profile> --region eu-central-1 \
  sesv2 create-email-identity --email-identity you@example.org
# click the confirmation link AWS sends to that inbox
```

Then send via the SDK:

```js
import { PigeonClient } from '@sprqvntrs/pigeon';
const client = new PigeonClient({ apiKey: 'ske_...', baseUrl: 'https://pigeon.example.com' });
await client.emails.send({
  from: 'mail@example.com',
  to: ['you@example.org'],
  subject: 'smoke test',
  html: '<p>hello</p>',
}, { idempotencyKey: crypto.randomUUID() });
```

Check the recipient inbox. Expected Gmail headers:

```
dkim=pass     header.i=@example.com
spf=pass      smtp.mailfrom=amazonses.com
dmarc=pass    action=none
```

Anything landing in spam = DNS or identity issue. Anything failing DKIM = DNS CNAMEs wrong (most common: proxied through Cloudflare instead of DNS-only).

### Step 7 — Wire event webhooks

The service already exposes `/v1/webhooks/ses` and the SNS subscription from Step 1 points at it. No additional work — bounces, complaints, deliveries all flow in automatically.

Verify end-to-end by sending a test message to `bounce@simulator.amazonses.com`. The DB row status should transition `queued → sent → bounced` within a few seconds.

---

## 2. Adding a new consumer

> **Prerequisite:** `PIGEON_ADMIN_URL` and `PIGEON_ADMIN_SECRET` must be set to the production admin API and its secret (from your secret store). Run the admin CLI from the repo root (see `packages/cli/README.md`). Run `pnpm --silent pigeon --help` to see all available commands.

For onboarding a new app or brand to the already-running service. Each consumer gets its own org, app, API key, and (usually) its own sending domain.

**No repeat of the production-access step.** Production access is per-account per-region; once your AWS account is out of sandbox, every domain verified in the same region sends to real recipients without any further AWS approval. If you find yourself re-opening an SES request form for a new consumer, something is wrong.

### Step 1 — Create the consumer's org + app

```bash
pnpm --silent pigeon apps create "<app-name>"
pnpm --silent pigeon keys create <app-id> --name "prod"
```

Captures app id and API key. Store the API key in your secret store and inject it into the consumer's env as `PIGEON_API_KEY`, with a different value per consumer.

### Step 2 — Register the consumer's sending domain

The domain the consumer will send *from*, e.g. `example.com` for the consumer's transactional mail.

```bash
curl -X POST https://pigeon.example.com/v1/domains \
  -H "Authorization: Bearer ${CONSUMER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name": "example.com"}'
```

The domain row is scoped to the consumer's org via RLS — only that API key can send from it.

### Step 3 — Publish DNS records

The domain owner (typically the same person doing the setup) publishes in Cloudflare (or wherever the domain's DNS lives):

- Three DKIM CNAMEs (from the `POST /v1/domains` response) — **DNS-only, not proxied**
- `v=spf1 include:amazonses.com ~all` TXT on the root (merge if one already exists — see below)
- `v=DMARC1; p=none` TXT at `_dmarc.<domain>` (escalate to `p=quarantine` / `p=reject` later). The API adds `; rua=mailto:<address>` when the operator sets `PIGEON_DMARC_RUA`
- One MX record (`feedback-smtp.<region>.amazonses.com`, priority 10). The API response always includes it — publish it on send-only domains, but **skip it if the domain already receives mail elsewhere** (Google Workspace, etc.). See below.

Each record in the `POST /v1/domains` response now carries a `notes` field with this same per-record guidance — worth checking before you paste anything into Cloudflare.

### Coexisting with an existing mail provider (Google Workspace etc.)

Plenty of consumer domains already receive mail through Google Workspace (or another provider) before pigeon is added for transactional sending. That's a supported setup — SES sending and the existing inbox provider share the domain fine as long as you follow a few rules:

- **SPF, merge into one record, never add a second.** Only one `v=spf1` TXT is allowed per domain. The trigger is the MX, not an existing SPF record: Google Workspace does not publish SPF by itself, so a Workspace domain often has none, and pasting pigeon's `include:amazonses.com`-only record there leaves every mail a person sends from Gmail failing SPF. A domain can run like that for months. If the MX points at a provider, the one record carries that provider's include next to SES's. If the domain already has SPF (Workspace's own record is typically `v=spf1 include:_spf.google.com ~all`), add `include:amazonses.com` into it:

  ```
  v=spf1 include:_spf.google.com include:amazonses.com ~all
  ```

  **Gotcha:** Google's Workspace setup wizard hands you `v=spf1 include:_spf.google.com ~all` and tells you to paste it in verbatim. On a domain that already sends through pigeon, pasting that over the existing record silently drops `include:amazonses.com` — SES sends keep working (DKIM alignment still carries DMARC) but SPF quietly starts failing. Always merge; never overwrite.

- **MX — skip pigeon's, keep the existing one.** The API always returns an MX record, but it only belongs on domains with no other inbox. If the domain already has MX pointed at Google Workspace, leave it alone — don't publish SES's feedback MX alongside it. The existing MX has to keep winning for inbound routing, and SES sending verification and DMARC both work fine without the SES MX being present.

- **DKIM — no conflict.** Google's DKIM selector (`google._domainkey.<domain>`) and SES's three per-token CNAMEs (`<token>._domainkey.<domain>`) live at different hostnames. Publish both; they don't collide.

- **DMARC — one shared record.** A single `_dmarc.<domain>` TXT covers mail from both senders — DMARC only cares that DKIM or SPF aligns, not which provider sent the message.

Two guards now catch the missing include. `pnpm --silent pigeon onboard` and `domains register` look up the domain's MX and print the merged SPF by themselves (`--receives-mail` still forces it). The DNS health check fails `spf_txt` when the MX points at Google Workspace or Microsoft 365 and the SPF lacks that provider's include, so an existing domain with the gap shows red in the admin UI instead of waiting for a Google Admin warning.

### Step 4 — Wait for verification

SES probes DNS every 5–30 min. The domain-verify worker tails SES and flips `dkim_status=verified` on the DB row. Monitor the same way as Step 5 of initial setup.

### Step 5 — Wire the consumer code

In the consumer app:

```ts
import { PigeonClient } from '@sprqvntrs/pigeon';

const client = new PigeonClient({
  apiKey: process.env.PIGEON_API_KEY!,
  baseUrl: process.env.PIGEON_BASE_URL!,
});

await client.emails.send({
  from: 'noreply@example.com',
  to: [user.email],
  subject: 'Welcome',
  html: '<p>...</p>',
}, { idempotencyKey: uuid() });
```

Deploy.

### Step 6 — First-send sanity check

After the first production deploy, send a known-address test (password reset, signup confirmation) and check the inbox headers. Same pass/fail criteria as Step 6 of initial setup.

---

## Troubleshooting

### Mail lands in spam, headers show `dkim=fail` or `dkim=none`
- CNAMEs are **proxied** in Cloudflare (orange cloud). Set to DNS-only (grey cloud).
- CNAMEs point at the wrong targets. Re-check against the `POST /v1/domains` response.
- DNS hasn't propagated. Wait 5–15 min, re-check with `dig +short CNAME <token>._domainkey.<domain>`.

### SES `status=PENDING` won't flip to `SUCCESS`
- All three DKIM CNAMEs must resolve before SES will verify.
- SES has its own retry cadence; adding records doesn't trigger an immediate re-probe. Typical window 5–30 min, sometimes longer.
- `VerificationInfo.ErrorType = HOST_NOT_FOUND` may be stale from the pre-publish probe. Ignore unless it persists >1h after records are live.

### Send fails with `MessageRejected: Email address is not verified`
- SES is in sandbox mode (expected for a fresh account) and the recipient isn't a verified identity.
- Fix for smoke tests: verify the specific recipient.
- Real fix: request production access (initial-setup Step 3).

### Send fails with `AccessDenied: not authorized to perform ses:SendEmail`
- The same applies to `ses:DeleteSuppressedDestination`, which the recipient erase route needs (`AccessDeniedException` in the service log).
- Runtime IAM policy is missing an action. Re-run `setup:aws` — it now includes `stepUpdatePolicyIfDrifted` which reconciles the live policy to match the source-of-truth document.

### Webhook events not arriving
- SNS subscription is still `PendingConfirmation`. Re-run `setup:aws` to re-send the handshake.
- Service's webhook route returns non-2xx. Check `/v1/webhooks/ses` handler logs.
- Wrong topic ARN in vault. Cross-check against `aws sns list-topics`.
