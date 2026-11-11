# Pigeon

Pigeon is a self-hosted transactional email service on AWS SES. It is for people who want their own sending service on their own AWS account, shared by several apps. Each app (tenant) gets its own API keys, sending domains, webhooks and audiences. The service handles DKIM, SPF and DMARC records, suppression of bounced and complaining addresses, inbound mail, DMARC aggregate reports and a recipient erase endpoint. It has an admin UI, an admin REST API, a typed TypeScript SDK and an admin CLI.

## What you need

- Node 22 or newer (`engines` in `package.json`; `.nvmrc` pins 24).
- pnpm 11.3.0 (`packageManager` in `package.json`).
- PostgreSQL. The migrations use the `citext` extension, which ships with standard Postgres.
- An AWS account with SES, to send real mail. Local development does not need it.

## Quickstart (local)

This gets the service running on your machine. It does not send real mail: that needs the AWS setup described in [apps/service/docs/setup.md](./apps/service/docs/setup.md).

```bash
git clone https://github.com/SPRQVNTRS/pigeon.git
cd pigeon
pnpm install

# The service reads apps/service/.env
cp .env.example apps/service/.env
```

Edit `apps/service/.env`. Set `SESSION_SECRET` to a long random string. Set `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` to the admin login you want. The `DB_*` values must point at your Postgres, and the database named in `DB_NAME` must exist. The defaults in `.env.example` match the compose file below.

Start Postgres. `apps/service/docker-compose.yml` starts one on port 5432 with user `postgres`, password `postgres` and a database named `pigeon`. These match `.env.example`:

```bash
docker compose -f apps/service/docker-compose.yml up -d
```

To use a Postgres you already have, set the `DB_*` values to match it and create the database named in `DB_NAME`.

Then migrate, seed and start:

```bash
pnpm --filter @sprqvntrs/pigeon-service drizzle:migrate
pnpm --filter @sprqvntrs/pigeon-service drizzle:seed
pnpm dev
```

- `drizzle:seed` creates the admin user (from `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD`), a demo app, a demo domain and one API key. It prints the key once, so copy it.
- `pnpm dev` runs the HTTP server and the background workers in one process.
- The service listens on `http://localhost:3601` (set `PORT` to change it).
- Health check: `curl http://localhost:3601/healthz` answers `{"status":"ok","check":"database",...}`.
- Admin UI: open `http://localhost:3601/login` and sign in with the admin user.

The service starts without AWS credentials. Sending real mail needs SES, an SNS topic, a runtime IAM user and a verified domain. [apps/service/docs/setup.md](./apps/service/docs/setup.md) walks through it, and [apps/service/scripts/README.md](./apps/service/scripts/README.md) documents the `setup:aws` script that creates the AWS resources.

## Send your first email

Install the SDK from npm in your app:

```bash
pnpm add @sprqvntrs/pigeon
```

Version 3 requires `baseUrl`. Use the API key of one app, and a `from` address on a domain you registered and verified for that app:

```ts
import { PigeonClient } from '@sprqvntrs/pigeon';

const client = new PigeonClient({
  apiKey: process.env.PIGEON_API_KEY!,
  baseUrl: 'https://pigeon.example.com',
});

const { id, status } = await client.emails.send(
  {
    from: 'Hello <hello@example.com>',
    to: ['user@example.org'],
    subject: 'Welcome',
    html: '<p>Thanks for signing up.</p>',
  },
  { idempotencyKey: crypto.randomUUID() },
);
```

The idempotency key lets the SDK retry on a 5xx answer without sending the mail twice. More in [packages/sdk/README.md](./packages/sdk/README.md).

## Docker

To build the service image, run this from the repository root. The root is the build context, because the Dockerfile copies `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `apps/service`, `packages` and the `.git` HEAD and refs (to derive a build hash). The build therefore needs a git clone, not a source archive:

```bash
docker build -f apps/service/Dockerfile.pnpm -t pigeon .
```

The container listens on port 3601. It reads its settings from environment variables, not from a file in the image. Use `.env.example` as the list: the server, database and superadmin variables are required, and the AWS variables are needed to send mail. Set `RUN_MIGRATIONS=true` to apply the database migrations when the container starts. For example:

```bash
docker run --env-file apps/service/.env -e RUN_MIGRATIONS=true -p 3601:3601 pigeon
```

Point `DB_HOST` at a Postgres the container can reach. `localhost` inside the container is the container itself.

## Deployment settings

A deployment chooses these settings with environment variables. Each default is the neutral or secure value. Details of the security settings are in [apps/service/docs/security.md](./apps/service/docs/security.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIGEON_SERVICE_NAME` | `pigeon` | Name that tags every log line. |
| `PIGEON_RATE_LIMIT` | `enforce` | `enforce` or `off`. Whether the per-key rate limit applies. |
| `PIGEON_WEBHOOK_PRIVATE_TARGETS` | `deny` | `deny` or `allow`. Whether a webhook may target a loopback, private or other non-public address. Use `allow` only in local development. |
| `PIGEON_WEBHOOK_PRIVATE_HOSTS` | empty | Comma-separated list of exact hostnames that may resolve to a private address. |
| `PIGEON_DMARC_RUA` | unset | Address for DMARC aggregate reports, such as `dmarc@dmarc.example.com`. Without it, the proposed DMARC record has no `rua` tag. |

The full list of variables, including the database, session, AWS and SNS settings, is in `.env.example`.

## Repository layout

- `apps/service/`: the React Router 7 server, Drizzle schema and migrations, pg-boss workers, AWS scripts and docs.
- `packages/sdk/`: the TypeScript SDK, `@sprqvntrs/pigeon`.
- `packages/cli/`: the admin CLI, `@sprqvntrs/pigeon-cli`.
- `CLAUDE.md`: instructions for coding agents.

## Docs

- [apps/service/docs/setup.md](./apps/service/docs/setup.md): initial AWS setup and adding a new consumer app.
- [apps/service/docs/ses-mechanics.md](./apps/service/docs/ses-mechanics.md): how SES works here, including DKIM, SPF, DMARC, sandbox mode, the domain lifecycle and the send flow.
- [apps/service/docs/security.md](./apps/service/docs/security.md): the security guards and the settings that control them.
- [apps/service/docs/webhooks.md](./apps/service/docs/webhooks.md): the webhook delivery contract for receivers.
- [apps/service/docs/inbound-mail.md](./apps/service/docs/inbound-mail.md): operations notes for inbound mail.
- [apps/service/docs/data-retention.md](./apps/service/docs/data-retention.md): what Pigeon stores, for how long, `retain_body: false` and the recipient erase endpoint.
- [apps/service/docs/concurrency.md](./apps/service/docs/concurrency.md): the state version and conditional writes.
- [apps/service/docs/local-e2e.md](./apps/service/docs/local-e2e.md): local end-to-end testing runbook.
- [apps/service/scripts/README.md](./apps/service/scripts/README.md): reference for the `setup:aws` and `teardown:aws` scripts.
- [packages/cli/README.md](./packages/cli/README.md): the admin CLI.
- [packages/sdk/README.md](./packages/sdk/README.md): the SDK.
- [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).

## Tests

```bash
pnpm typecheck                                  # service, SDK and CLI
pnpm --filter @sprqvntrs/pigeon-service test    # needs Postgres, see below
pnpm --filter @sprqvntrs/pigeon test
pnpm --filter @sprqvntrs/pigeon-cli test
```

The service tests that use a database create and drop their own databases on the Postgres named by the `DB_*` variables. If your Postgres is not on port 5432, set `DB_PORT`.

## License

MIT. See [LICENSE](./LICENSE).
