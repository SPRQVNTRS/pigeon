# SES mechanics — high-level

How sending actually works end-to-end. Read this before configuring a new domain or debugging a delivery failure.

## The players

- **Email service (this app)** — receives API requests from consumer apps, stores them in Postgres, hands them to SES for delivery, records delivery events.
- **AWS SES** — the actual mail-sending infrastructure. Signs messages with DKIM, hands them to receiving mail servers, emits events (sends / bounces / complaints / deliveries) back to us via SNS.
- **DNS (domain owner)** — publishes records that prove we're authorized to send on behalf of a domain and lets receiving mail servers verify signatures.
- **Consumer apps**, call our SDK / REST API; never touch SES directly.

## The three DNS authentication standards

Receiving mail servers (Gmail, Outlook, etc.) reject or spam-folder mail that can't prove the sender is authorized. Three stacked standards make that proof possible:

### DKIM (signature)
**What:** a cryptographic signature attached to every outbound message, verified against a public key we publish in DNS.
**How we use it:** SES generates a keypair per domain. We publish three CNAME records pointing at `*.dkim.amazonses.com` (AWS hosts the public keys). SES automatically signs every message we send.
**Why it matters most:** DKIM is the backbone — even if SPF fails or misaligns, DKIM alone is enough to pass DMARC.

### SPF (authorized senders)
**What:** a TXT record listing which IPs/services are allowed to send on behalf of a domain.
**How we use it:** `v=spf1 include:amazonses.com ~all` — "Amazon SES IPs are authorized senders for this domain."
**Caveat:** SPF checks the **envelope sender** (MAIL FROM), not the visible `From:` header. Without a custom MAIL FROM subdomain, SES uses `amazonses.com` as the envelope, so SPF passes but isn't *aligned* with the visible From. That's fine — DMARC accepts alignment from either DKIM or SPF.

### DMARC (policy)
**What:** a TXT record at `_dmarc.<domain>` that tells receivers what to do with mail that fails DKIM **and** SPF alignment.
**Policies:**
- `p=none` — monitor only, deliver everything. Safe default.
- `p=quarantine` — suspicious mail to spam.
- `p=reject` — suspicious mail rejected outright. The end state once you're confident in your sending setup.
**Report address:** the record Pigeon proposes carries `rua=mailto:<address>` only when the operator sets `PIGEON_DMARC_RUA`. Without it the record is `v=DMARC1; p=none`, and the DNS health check accepts any DMARC record. With it, the health check also requires that address.
**Escalation path:** always start at `p=none`. Escalate only after monitoring aggregate reports (via `rua=mailto:...`) for enough time to confirm no legitimate traffic is misaligned. Jumping to `p=reject` without monitoring will block vendors you forgot about.

## SES sandbox mode

Every new AWS account starts with SES in **sandbox mode**. Sandbox exists to stop AWS from being a spam source while a new account establishes itself.

### What sandbox blocks

In sandbox mode SES refuses to deliver mail unless **both** sides of the send are pre-verified identities in your SES account:

- **Sender** — the `From:` address. Verified via domain verification (any address under a verified domain works) or by verifying a single email address.
- **Recipient** — every `To:` / `Cc:` / `Bcc:` address. You click a link in a confirmation email AWS sends to that mailbox.

Daily quota is also capped at 200 sends and 1/sec.

### Why that's incompatible with production use

Consumer apps send to **end users** — arbitrary email addresses we can't pre-verify. Sandbox mode is fundamentally incompatible with a transactional email platform.

### Getting out: request production access

- Open the SES console → "Request production access"
- Fill in the form with:
  - **Mail type:** Transactional (or Transactional + Marketing if newsletters are involved)
  - **Bounce/complaint handling:** event destinations → SNS → webhook → store event on the DB row (already wired in this service)
  - **Recipient opt-in:** account signup confirmation; newsletter double opt-in
  - **List hygiene:** automatic suppression on hard bounces / complaints
- AWS reviews within ~24 hours. Once approved: no recipient verification needed, quota lifted.

**Sandbox-mode smoke testing is still useful:** adding a recipient identity (e.g. your own email) lets you send one real message through the full pipeline and inspect the headers in Gmail to confirm `dkim=pass` / `spf=pass` / `dmarc=pass`. That validates the DNS setup without waiting 24h for production access.

## Identities, explained

"Identity" in SES is an overloaded term. There are two kinds and they do different things:

### Domain identity (`example.com`)
Represents ownership of a whole domain. Verified by publishing DKIM CNAMEs. Once verified, **any** `*@example.com` address is usable as a sender without further work. This is the production pattern.

### Email-address identity (`mail@example.com`, `you@example.org`)
Represents ownership of a single mailbox. Verified via confirmation-link email. Two independent uses:

1. **As a sender** — lets that one address send mail before the full domain is verified. A quick shortcut while waiting on DNS propagation.
2. **As a sandbox recipient** — required in sandbox mode to allow delivery *to* that address.

The same identity type covers both roles, AWS makes no distinction. `you@example.org` getting verified doesn't give it sending rights for `example.com`; it just tells SES "you're allowed to deliver test mail to this inbox while in sandbox."

## Domain lifecycle

1. **Register** — consumer app calls `POST /v1/domains` with the domain name. Service calls `ses:CreateEmailIdentity`, captures the three DKIM tokens, stores a row with `dkim_status=pending`.
2. **Publish DNS** — domain owner adds the 3 CNAME records (DKIM), SPF TXT, DMARC TXT. CNAMEs must be DNS-only (not proxied) — proxying breaks DKIM.
3. **SES probes** — AWS re-checks the records on its own schedule (5–30 min typical). When all three DKIM tokens resolve, identity flips to `SUCCESS`.
4. **Webhook update** — SES event destination fires on verification-status change → our `/v1/webhooks/ses` endpoint → DB row flips to `dkim_status=verified`, `verified_at` timestamped.
5. **Ready to send** — consumer apps can now send from any address under the domain.

## End-to-end send flow (post-verification, post-sandbox)

```
consumer app                    pigeon                       SES                    recipient
     │                                │                               │                         │
     │ SDK.emails.send({from, to})    │                               │                         │
     ├───────────────────────────────►│                               │                         │
     │                                │ write row (status=queued)     │                         │
     │                                │ enqueue pg-boss job           │                         │
     │ { id, status: 'queued' }       │                               │                         │
     │◄───────────────────────────────┤                               │                         │
     │                                │                               │                         │
     │                                │ worker picks up job           │                         │
     │                                │ ses:SendEmail (DKIM signed)   │                         │
     │                                ├──────────────────────────────►│                         │
     │                                │ messageId                     │                         │
     │                                │◄──────────────────────────────┤                         │
     │                                │ row status=sent               │                         │
     │                                │                               │ DKIM-signed SMTP        │
     │                                │                               ├────────────────────────►│
     │                                │                               │                         │
     │                                │                               │ Delivery / Bounce /     │
     │                                │                               │ Complaint event         │
     │                                │◄──────────────────── SNS ────┤                         │
     │                                │ webhook → update row          │                         │
```

Key guarantees:
- **Idempotency:** each send accepts an optional idempotency key; repeats within the retention window return the original result.
- **No silent drops:** every state change (queued / sent / delivered / bounced / complained) is recorded on the DB row.
- **Self-hostable:** no dependency on external services beyond AWS SES; the service runs on our own infra.

## What's owned by whom — quick reference

| Concern | Owner | Notes |
|---------|-------|-------|
| DNS records (DKIM/SPF/DMARC) | Domain owner (manual DNS step) | One-time per domain |
| SES identity lifecycle | pigeon | Tracked in `domains` table |
| Sending / retries / queueing | pigeon worker | pg-boss-backed |
| Signing keys | AWS SES | We never see them — only publish the CNAMEs |
| Bounce / complaint storage | pigeon DB | Updated via SNS webhook |
| Suppression list | pigeon (future) | Reject future sends to addresses that hard-bounced |
