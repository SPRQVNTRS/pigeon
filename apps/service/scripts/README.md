# apps/service/scripts

Operator scripts for pigeon. Not part of the running app.

## aws-setup.ts

Idempotent bootstrap for the AWS side of pigeon. Creates:

1. SNS topic `<prefix>-events-<stage>`
2. SES configuration set `<prefix>-<stage>`
3. SES event destinations (bounce, complaint, delivery, reject) pointing at the topic
4. IAM runtime policy `<prefix>-runtime-<stage>`
5. IAM user `<prefix>-<stage>` with the policy attached
6. IAM access key for the user (secret printed once; never written to disk)
7. Optional: SNS subscription for a webhook URL
8. Optional: SES email identity (domain or address) verification
9. The DMARC intake: S3 bucket, SNS topic, SES receiving domain, receipt rule set and rule, and the webhook subscription

### Run

```
pnpm --filter @sprqvntrs/pigeon-service setup:aws
```

### Required environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `AWS_REGION` | yes | SES region (must match where identities live) |
| `STAGE` | yes | `dev`, `staging`, or `prod` (used as resource suffix) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **or** `AWS_PROFILE` | yes | Admin credentials. Consumed by the default SDK credential chain. |
| `WEBHOOK_ENDPOINT_URL` | no | HTTPS URL to subscribe to the topic. Confirmation completes on first POST by the running service. |
| `SES_VERIFY_IDENTITY` | no | Domain or address to verify. Domains emit DKIM DNS records to stdout; addresses receive a confirmation email. |
| `RESOURCE_PREFIX` | no (default `pigeon`) | Resource name prefix before stage suffix |
| `PIGEON_PUBLIC_URL` | yes | Public https base URL of the deployment, for example `https://pigeon.example.com`. The DMARC webhook is `<url>/v1/webhooks/dmarc`. |
| `PIGEON_INBOUND_BUCKET` | yes | S3 bucket that holds received tenant mail. Named in the runtime IAM policy. |
| `PIGEON_DMARC_BUCKET` | yes | S3 bucket that holds DMARC aggregate reports. Created by the script and named in the runtime IAM policy. |
| `PIGEON_DMARC_DOMAIN` | yes | Domain that receives DMARC aggregate reports, for example `dmarc.example.com`. Registered as an SES receiving identity. |

The four `PIGEON_*` variables name resources of one deployment, so the repo
carries no defaults for them. If one is missing the script stops with a message
that names it, before the preflight and before any AWS call. This holds for
`--dry-run` too. The values are read in one place,
`scripts/lib/script-settings.ts`.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--yes` | false | Skip the interactive confirmation prompt (required in CI / non-TTY) |
| `--dry-run` | false | Run preflight + print the plan; create nothing |
| `--write-env` | false | Reserved; currently unused. Script always prints the env block to stdout. |

### Admin permissions

The invoking identity needs the actions listed in
`apps/service/scripts/lib/preflight.ts::REQUIRED_ACTIONS`. At a high level:

- `sts:GetCallerIdentity`
- `iam:*` for policy / user / access-key lifecycle (Create, Get, Delete, List, Attach, Detach)
- `sns:*` for topic lifecycle + subscriptions
- `ses:*` for configuration set + event destination + email identity lifecycle
- `iam:SimulatePrincipalPolicy` (optional but recommended — enables a real
  preflight check. If denied, the script warns and proceeds best-effort.)

### State file

`apps/service/.aws-setup.state.json` (gitignored).

Records what the script created so `teardown:aws` knows what to remove. The
file is written atomically (write-to-temp + rename). It does **not** contain
the access key secret — that's only emitted to stdout once at create time.

If you lose the state file, AWS still holds every resource. You can
reconstruct the file by re-running `setup:aws` (all steps are idempotent
against live AWS state), except for the access key, which the script will
decline to recreate automatically (delete the stale key in the console
first).

### Idempotency

Every step is `create-if-missing`:

- `sns:CreateTopic` is AWS-native idempotent (returns the existing ARN).
- `GetConfigurationSet` + `GetConfigurationSetEventDestinations` gate the
  SES creates.
- `GetPolicy` / `GetUser` / `ListAttachedUserPolicies` gate the IAM creates.
- The access key step is skipped entirely if the state file already
  records one.

If the script detects drift — for example, an event destination of our name
that points at a different SNS topic — it **aborts with a remediation hint**
rather than silently overwriting live configuration.

## aws-inbound.ts

AWS side of inbound mail (SES receiving, S3, SNS, `POST /v1/webhooks/inbound`).
Dry run by default; `--apply` acts. The flags are listed in the header of
`aws-inbound.ts`.

```
PIGEON_INBOUND_BUCKET=<bucket> \
  pnpm --filter @sprqvntrs/pigeon-service setup:aws:inbound -- --domain reply.example.com
```

| Variable | Needed when | Meaning |
| --- | --- | --- |
| `PIGEON_INBOUND_BUCKET` | always | S3 bucket that holds received tenant mail |
| `PIGEON_PUBLIC_URL` | `--subscribe` | Public https base URL; the subscription endpoint is `<url>/v1/webhooks/inbound` |
| `PIGEON_DMARC_BUCKET` | `--update-runtime-policy` | DMARC report bucket, named in the runtime IAM policy it pushes |

The script asks only for the variables its flags need, and stops before any
AWS call when one is missing.

## aws-teardown.ts

Reverses everything `aws-setup.ts` created, strictly based on the state file.

```
pnpm --filter @sprqvntrs/pigeon-service teardown:aws
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--yes` | false | Skip the confirmation prompt (dev/staging only) |
| `--confirm-word=delete` | — | Required in `prod` instead of `--yes` — type the literal word `delete` |

### Safety

- Loads the state file and refuses to run if resource names don't match the
  naming convention setup uses. This protects against a tampered or foreign
  state file.
- Deletes in reverse creation order.
- Treats `NotFound` on delete as "already gone" and continues.
- Archives the state file to
  `.aws-setup.state.<timestamp>.json.archived` instead of removing it.

### Out of scope

- DNS records (Route 53 / Cloudflare): the script prints DKIM records for
  domain identities but never touches DNS.
- Secret store provisioning for the deployment: the script prints the env block once, and you store it yourself.

## Using a named admin profile

You can keep admin credentials in a named AWS profile in `~/.aws/config` and
use it without exporting `AWS_PROFILE` manually. In the examples below the
profile is `<admin-profile>`.

### Running a script with a profile

`setup:aws:dev` runs the same script as `setup:aws` and sets no profile. Set
`AWS_PROFILE` yourself, in your shell or on the command line:

```
AWS_PROFILE=<admin-profile> pnpm --filter @sprqvntrs/pigeon-service setup:aws:dev
```

### With extra flags, or for teardown

Prefix any script with `AWS_PROFILE=<admin-profile>`:

```
AWS_PROFILE=<admin-profile> pnpm --filter @sprqvntrs/pigeon-service setup:aws --dry-run --yes
AWS_PROFILE=<admin-profile> pnpm --filter @sprqvntrs/pigeon-service teardown:aws --yes
```

`AWS_PROFILE` is a standard AWS SDK credential-chain variable. Any named profile
in `~/.aws/credentials` or `~/.aws/config` works.
