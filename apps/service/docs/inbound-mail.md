# Inbound mail (`email.received`): operations notes

Design and code: the "Inbound Mail" section of `apps/service/CLAUDE.md`. AWS:
`scripts/aws-inbound.ts`.

The live resources of an instance (SES identity, receipt rules, bucket, SNS
topic, IAM policy versions, inbound domain rows), its open points and its dated
findings are operator data and not part of this repo.

## Rollback

1. Stop intake: delete the receipt rule.
   `aws ses delete-receipt-rule --rule-set-name pigeon-receive-rules --rule-name <receipt-rule>`
2. IAM back to the previous policy. To undo only the erase change, set the
   version before the `DeleteInboundMail` statement was added. To undo all of
   inbound, set the version before `ReadInboundMail` was added:
   `aws iam set-default-policy-version --policy-arn arn:aws:iam::<aws-account-id>:policy/<runtime-policy> --version-id <previous-version>`
3. Code back: roll the service back to the previous release. Without
   `INBOUND_SNS_TOPIC_ARN` the route answers 503.

Use `--profile <admin-profile> --region <region>` on every `aws` call.

## Sender authentication (from_authenticated)

Anyone can write any From address into a mail. The `from` field of
`email.received` is therefore not proof of the sender. Since 2026-11-09 the
event says whether the From domain is proven. A receiver that trusts `from`
(for example to match a ticket requester) must check `from_authenticated`.

The new fields come after the old ones, because the body is signed as sent:

- `verdicts.dmarc`: the SES receipt `dmarcVerdict`, last in `verdicts`, only
  when SES sent it.
- `from_authenticated`: true or false.
- `authentication`: `from_domain`, `dkim_pass_domains`, `dkim_aligned`,
  `spf_domain`, `spf_aligned`, `dmarc_pass`, `ses_header_trusted`,
  `single_from`, in this order. Domains only, never an address.

The rule (`app/lib/inbound/authentication.ts`). `from_authenticated` is true
when the mail has exactly one From header with exactly one address, that
address has a domain, and one of these holds:

1. The SES receipt says dmarc PASS. If the SES header names the From domain
   it checked (`header.from`), that domain must be the From domain.
2. The SES receipt says dkim PASS, and a `dkim=pass` domain in the SES header
   is aligned with the From domain.
3. The SES receipt says spf PASS, the SES header says `spf=pass`, and the
   envelope sender domain (`smtp.mailfrom` or `envelope-from`) is aligned
   with the From domain.

The SES receipt comes in the signed SNS message, so it is trusted. It does
not say which domain passed. The `Authentication-Results` header that SES
adds to the raw mail names the domains. A sender can add a header like that
too. Trust rule: only the first `Authentication-Results` header of the mail
counts. Its authserv-id (the text before the first `;`) must be exactly
`amazonses.com`, and it must come before the first `X-SES-RECEIPT` header.
SES adds both above all the headers of the sender. If the rule fails, the
header gives no domains, and only the dmarc branch can pass.

The single From rule: with two From headers, the MIME reader keeps the last
one, but SES can check DMARC on another one. A list of From addresses has the
same gap. Such a mail is never authenticated.

Alignment is an approximation. There is no public suffix list. Two domains
align when they are equal, or when one is a subdomain of the other on a label
boundary (`mail.example.com` and `example.com`). `badexample.com` and
`example.com` do not align. This is stricter than DMARC for sibling
subdomains (`a.example.com` and `b.example.com`). It is looser in one case:
if the From domain is itself a public suffix that gives subdomains to other
people, such as a shared hosting domain, a subdomain of another owner aligns
with it.

Rows received before this change have no stored dmarc verdict. A replay of
such a row still gets the DKIM and SPF branches.

The worker logs only `fromAuthenticated` and `sesHeaderTrusted` with the
inbound id. It never logs a domain.

## Auto-replies (auto)

An out-of-office reply or a bulk mail is not a person writing to you. The
event now carries an `auto` object, the last key of `data`, after
`authentication`. It has four keys, in this order: `auto_submitted`,
`precedence`, `auto_response_suppress`, `is_auto`.

The first three are the raw values of the headers `Auto-Submitted`,
`Precedence` and `X-Auto-Response-Suppress`. Each value is trimmed, lower
case and cut to 200 characters. It is `null` when the header is absent or
empty. When a header appears twice, the first one counts. The object holds
header values only, never an address.

`is_auto` is true when one of these holds (`app/lib/inbound/auto-reply.ts`):

1. `Auto-Submitted` is present and its keyword is not `no`. The keyword is the
   first word before any `;` or comment, so `auto-replied (vacation)` has the
   keyword `auto-replied`.
2. The `Precedence` keyword is `bulk`, `junk` or `auto_reply`. `list` is a
   mailing list, not an auto-reply, so it does not count.
3. `X-Auto-Response-Suppress` is present with any value.

A sender can write these headers too. Use `is_auto` to skip auto-replies, for
example to not open a ticket. Do not use it as proof of anything.

The worker logs only `isAuto` with the inbound id.

## Recipient erase

`POST /v1/recipients/erase` erases received mail from the address, for the
app of the API key only. Another app's mail from the same sender stays.

How the erase finds the mail:

- `inbound_emails.sender_hash` holds a keyed hash of the From address, never
  the address. `inbound.process` writes it after the MIME parse and before
  the fan-out (`app/lib/inbound/sender-hash.ts`).
- The hash key is derived from `SESSION_SECRET` for this one purpose. It is
  never the session secret itself. There is no new env key.
- The worker and the erase use one shared function to normalise an address
  (`app/lib/email-address.ts`). It takes the bare address out of a From with
  a display name, trims it and makes it lower case.

What the erase deletes, in this order:

1. The raw mail in S3 (`<inbound-bucket>/incoming/<stage>/`) of each
   matching row. This step runs before the database transaction. With no
   matching row, it makes no S3 call. If an S3 delete fails, the route
   answers 500 and deletes nothing in the database. A retry finds the same
   rows again.
2. In the transaction: the `email.received` delivery jobs on
   `webhook.deliver.inbound` whose sender is the address, and the
   `inbound.process` jobs of the matching rows. Both are deleted from
   `pgboss.job` and, when it exists, `pgboss.archive`.
3. In the same transaction: the matching `inbound_emails` rows.

The runtime IAM user needs `s3:DeleteObject` on
`<inbound-bucket>/incoming/*` (statement `DeleteInboundMail` in
`scripts/lib/runtime-policy.ts`). Push it with
`pnpm setup:aws:inbound -- --update-runtime-policy --apply`. Until then
every erase for an address with received mail answers 500.

Stated limits:

- Rows received before this change have no hash. The erase cannot find them.
  They age out in under 7 days.
- A mail that `inbound.process` has not handled yet has no hash yet. This
  gap lasts seconds. An erase in that gap misses that mail. A second erase
  a minute later covers it.
- If `inbound.process` writes the hash while an erase runs, the erase can
  delete the row but miss its S3 object. That object has no row left and
  expires in under 7 days.
- A `SESSION_SECRET` rotation unlinks older hashes. The erase cannot find
  mail hashed under the old secret. That mail ages out in under 7 days.
- A mail with no From address has no hash. It has no sender to erase.
- `inbound_emails.recipients` holds only the addresses on the tenant's own
  inbound domain, such as the reply addresses your app makes
  (`ticket-...@reply.example.com`). An erase does not match on them.

Retention still applies to everything above: `inbound_emails` rows 7 days
minus 1 hour; inbound jobs 1 hour after they finish and 2 days at most in
any state; S3 `incoming/` 6 days (S3 expires at the next 00:00 UTC, so under
7 days). The `inbound-retention` task enforces them every 15 minutes. The
values are pinned by `test/inbound-retention-limits.test.ts`, and the erase
is tested in `test/recipient-erase.test.ts`.

## DMARC reports

Reporters mail aggregate reports to `dmarc@in.example.com`. Receipt rule
`pigeon-dmarc-reports-<stage>` (first in `pigeon-receive-rules`) stores the mail
in `<dmarc-bucket>/incoming/<stage>/` (expires after 90 days) and
notifies `pigeon-dmarc-ingest-<stage>`. `POST /v1/webhooks/dmarc` accepts only
that topic (`DMARC_SNS_TOPIC_ARN`; unset means 503), reads at most 10 MB of
mail, unpacks at most 20 MB per attachment and stores `dmarc_reports` and
`dmarc_records`. Code: `app/lib/dmarc/sns-dmarc.ts`.

### Report authorization records

Reporters such as Google, Microsoft and Yahoo send a domain's reports to
another org domain only when that domain allows it (RFC 7489, section 7.1).
The zone of the report domain (`example.com`) holds one TXT record `"v=DMARC1"`
per reported domain, at `<domain>._report._dmarc.in.example.com`, DNS only.
There is no wildcard on purpose: a new domain that sends `rua` here needs its
own record. `example.com` needs none (same org domain). The records of a live
instance, with their ids, are operator data and not part of this repo.

Rollback:

1. DNS: delete a record by id with your DNS provider's API.
2. Rule recipient back to the old value (SES then rejects every report again):
   `aws ses describe-receipt-rule --rule-set-name pigeon-receive-rules --rule-name pigeon-dmarc-reports-<stage> --query Rule > rule.json`,
   set `Recipients` to `["*@in.example.com"]`, then
   `aws ses update-receipt-rule --rule-set-name pigeon-receive-rules --rule file://rule.json`.
3. Code back: roll the service back to the previous release. Without
   `DMARC_SNS_TOPIC_ARN` the route answers 503.
