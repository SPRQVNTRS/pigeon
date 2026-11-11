# Local E2E Runbook: Part A and Part B

Reproduction guide for running pigeon locally and exercising it
end-to-end with real AWS SES sends. Covers **Part A** (pure local, no AWS) and
**Part B** (live SES sandbox). This runbook does not cover the later parts (SDK-driven domain create/verify, inbound mail).

---

## Prerequisites

- A local Postgres (see `apps/service/docker-compose.yml`, port 5432), with `DB_*` in `apps/service/.env` pointing at it
- Node 22 or newer and pnpm 11.3.0

The service listens on **port 3601** (see `.env.example`). Workers are inline in
`server.ts`, no separate worker process.

```bash
pnpm --filter @sprqvntrs/pigeon-service dev
```

---

## Part A: pure local (no AWS)

Runs without any AWS credentials. Uses the mocked SES client.

### 1. Apply migrations and seed

```bash
pnpm --filter @sprqvntrs/pigeon-service drizzle:migrate
pnpm --filter @sprqvntrs/pigeon-service drizzle:seed
```

Seed creates:
- Admin user: `admin@example.com`
- App: Demo App (app id printed to stdout)
- Domain: `mail.example.com`
- API key: printed once. Save it to `apps/service/.env` as `CONTRACT_TEST_API_KEY`

### 2. Run service unit tests

```bash
pnpm --filter @sprqvntrs/pigeon-service test
```

Expected: every test passes. The DB-backed files create and drop their own databases.

### 3. Run SDK unit tests

```bash
pnpm --filter @sprqvntrs/pigeon test
```

Expected: every test passes.

---

## Part B: live SES sandbox

### Prerequisites

- AWS SES sandbox access (verify a sender identity in AWS console)
- `apps/service/.env` populated, see `.env.example`

Required env vars for Part B (in addition to DB vars already set):

| Variable | Purpose |
|----------|---------|
| `AWS_ACCESS_KEY_ID` | Runtime IAM user access key (from `pnpm setup:aws` output) |
| `AWS_SECRET_ACCESS_KEY` | Runtime IAM secret |
| `AWS_REGION` | SES region (e.g. `eu-central-1`) |
| `AWS_SES_FROM_ADDRESS` | Verified SES sender identity |
| `AWS_SES_CONFIG_SET` | SES configuration set name (e.g. `pigeon-dev`) |
| `TEST_RECIPIENT_EMAIL` | Verified SES recipient for test sends |
| `CONTRACT_TEST_API_KEY` | API key from seed step above |

### Bootstrap AWS resources (one time)

Use the `setup:aws` script to provision SNS topic, SES config set, event
destinations, and runtime IAM user:

```bash
AWS_REGION=eu-central-1 STAGE=dev \
  WEBHOOK_ENDPOINT_URL=https://<your-tunnel>.trycloudflare.com \
  PIGEON_PUBLIC_URL=https://<your-tunnel>.trycloudflare.com \
  PIGEON_INBOUND_BUCKET=<inbound bucket> \
  PIGEON_DMARC_BUCKET=<dmarc bucket> \
  PIGEON_DMARC_DOMAIN=<dmarc receiving domain> \
  pnpm --filter @sprqvntrs/pigeon-service setup:aws
```

The four `PIGEON_*` variables name the deployment's buckets, receiving domain
and public URL. The script has no defaults for them and stops before any AWS
call if one is missing. See `apps/service/scripts/README.md`.

Paste the printed env block into `apps/service/.env`.

### Start the service

```bash
pnpm --filter @sprqvntrs/pigeon-service dev &
```

Wait for `<service name> started` in the logs (the service name is `PIGEON_SERVICE_NAME`, `pigeon` while unset). Service listens on port 3601.

### Send a test email via SDK

```js
// send-test.mjs
import { PigeonClient } from '@sprqvntrs/pigeon';

const client = new PigeonClient({
  apiKey: process.env.CONTRACT_TEST_API_KEY,
  baseUrl: 'http://localhost:3601',
  maxRetries: 0,
});

const result = await client.emails.send({
  from: process.env.AWS_SES_FROM_ADDRESS,
  to: [process.env.TEST_RECIPIENT_EMAIL],
  subject: 'Local E2E test',
  html: '<p>hello from local service</p>',
}, { idempotencyKey: crypto.randomUUID() });

console.log(result); // { id: '...', status: 'queued' }
```

### Verify DB row transitions to `sent`

```bash
docker compose -f apps/service/docker-compose.yml exec postgres psql -U postgres -d pigeon \
  -c "SELECT id, status, message_id, sent_at FROM emails ORDER BY created_at DESC LIMIT 5;"
```

Expected: `status = 'sent'`, `message_id` populated with SES message ID.

### Run SDK contract tests against running service

```bash
CONTRACT_TEST_BASE_URL=http://localhost:3601 \
CONTRACT_TEST_API_KEY="$CONTRACT_TEST_API_KEY" \
pnpm --filter @sprqvntrs/pigeon test:contract
```

The domain and audience cases skip unless `CONTRACT_TEST_DOMAIN_ID` and
`CONTRACT_TEST_AUDIENCE_ID` are set; a skip is not a failure.

---

## Discovered issues (logged, not blockers)

1. **Domain pre-insert shortcut**: Part A/B use a seed-created domain
   (`mail.example.com`) rather than exercising `email.domains.create()` from
   the SDK. The proper SDK-driven domain create/verify flow is Part C.

2. **DB-backed tests time out in some full-suite runs (seen 2026-11-09)**:
   about half of 12 runs against a shared Postgres failed with 5 s /
   30 s test and hook timeouts in the files that use a real database, also
   without the inbound change; two later runs passed 528/528. Root cause not
   proven (load from other sessions on the shared Postgres is the suspect).
   If your Postgres is not on port 5432, set `DB_PORT`; without it every
   DB-backed file fails with `ECONNREFUSED 127.0.0.1:5432`, which is a
   different failure.

---

## SDK version reference

| Version | Path prefix | Notes |
|---------|-------------|-------|
| 0.1.0   | `/api/v1/`  | Wrong, do not use |
| 0.2.0   | `/v1/`      | Correct, the canonical prefix |
