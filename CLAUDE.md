# Pigeon

Custom email-sending service (codename: pigeon) built on a React Router 7 + Drizzle + Postgres + pg-boss stack. Tenancy is enforced in application code (`app_id` filters), not by Postgres row level security. Provides a typed SDK (`@sprqvntrs/pigeon`) for consumer apps, published to the public npm registry.

For the high-level SES mechanics (DKIM/SPF/DMARC, sandbox mode, identities, domain lifecycle, end-to-end send flow), see [apps/service/docs/ses-mechanics.md](./apps/service/docs/ses-mechanics.md). Read it before configuring a new domain or debugging a delivery failure.

For operational setup flows, standing up a new stage from scratch, or onboarding a new consumer, see [apps/service/docs/setup.md](./apps/service/docs/setup.md).

## Repository Layout

```
pigeon/
├── apps/
│   └── service/          # @sprqvntrs/pigeon-service, RR7 server + Express + pg-boss workers
│       ├── app/           # React Router routes, components, services
│       ├── drizzle/       # Schema, migrations, seed
│       ├── server.ts      # Express entrypoint; also starts the pg-boss workers
│       ├── start.sh       # Container entrypoint (optional migrations, then server.ts)
│       ├── Dockerfile.pnpm  # Production image; build context is the repo root
│       └── docker-compose.yml  # Local Postgres
├── packages/
│   ├── cli/              # @sprqvntrs/pigeon-cli, the admin CLI (private), see packages/cli/README.md
│   └── sdk/              # @sprqvntrs/pigeon, published to npm
├── pnpm-workspace.yaml
├── tsconfig.base.json    # Shared TypeScript compiler options
└── .env.example
```

## Prerequisites

1. No token is needed to install. Every dependency, including the four `@sprqvntrs/*` packages (`helpers`, `llm`, `logger`, `workflows`), comes from the public npm registry. Publishing the SDK runs in `.github/workflows/release-sdk.yml` and needs an npm token there.
2. Copy `.env.example` → `apps/service/.env` and fill in values.
3. Node ≥ 22, pnpm 11.3.0 (from packageManager).

## Quick Start

```bash
# From repo root
pnpm install

# Start local Postgres (creates the database `pigeon`)
docker compose -f apps/service/docker-compose.yml up -d

# Run migrations and seed
pnpm --filter @sprqvntrs/pigeon-service drizzle:migrate
pnpm --filter @sprqvntrs/pigeon-service drizzle:seed

# Run dev (server and workers, one process, restarts on change)
pnpm dev
# or filter explicitly:
pnpm --filter @sprqvntrs/pigeon-service dev
```

## Running Individual Commands

```bash
# Typecheck all packages
pnpm typecheck

# Typecheck service only
pnpm --filter @sprqvntrs/pigeon-service typecheck

# Typecheck SDK only
pnpm --filter @sprqvntrs/pigeon typecheck

# Typecheck the admin CLI only, run its tests, or run it
pnpm --filter @sprqvntrs/pigeon-cli typecheck
pnpm --filter @sprqvntrs/pigeon-cli test
pnpm --silent pigeon status

# Build the SDK
pnpm --filter @sprqvntrs/pigeon build

# Build the service
pnpm --filter @sprqvntrs/pigeon-service build
```

## Drizzle Migrations

**IMPORTANT: All drizzle-kit commands must run from `apps/service/` (or via pnpm filter from the repo root) so the config and relative paths resolve correctly.**

```bash
# Via pnpm filter from repo root (preferred)
pnpm --filter @sprqvntrs/pigeon-service drizzle:generate
pnpm --filter @sprqvntrs/pigeon-service drizzle:migrate

# Or cd into apps/service/ first
cd apps/service
pnpm drizzle:generate
pnpm drizzle:migrate
```

After running `drizzle-kit generate`, verify the new entry's `when` timestamp in `drizzle/migrations/meta/_journal.json` is **strictly greater** than the previous entry. Drizzle's migrator silently skips out-of-order timestamps, with no error and no warning. Never hand-edit `when` values.

## Server and Workers

There is one process. `server.ts` runs Express and React Router SSR, and it also starts the pg-boss workers and registers the scheduled tasks via `@sprqvntrs/workflows`. There is no separate worker entrypoint. `pnpm dev` runs `tsx watch ./server.ts`. In production the container runs `start.sh`, which runs `server.ts`.

## `@sprqvntrs/*` Dependency Policy

All `@sprqvntrs/*` dependencies (`helpers`, `llm`, `logger`, `workflows`) come from the public npm registry, so `pnpm install` and the Docker build need no token and no registry mapping. There is no `.npmrc` in the repo. Do not add a scope mapping to GitHub Packages: its tarballs differ from the public ones and the lockfile integrity check would fail.

The packages ship raw TypeScript. The service runs them through `tsx` at runtime, so keep `tsx` in the production image.

The SDK (`@sprqvntrs/pigeon`) publishes to the public npm registry.

## Checks

`.githooks/pre-push` is the gate. It runs typecheck (service + sdk + cli), then the service build. Enable it with `git config core.hooksPath .githooks`. It runs `pnpm` on the host, or through corepack if `pnpm` is not on PATH.

To run the same checks by hand:

```bash
pnpm install
pnpm --filter @sprqvntrs/pigeon-service typecheck
pnpm --filter @sprqvntrs/pigeon typecheck
pnpm --filter @sprqvntrs/pigeon-cli typecheck
pnpm --filter @sprqvntrs/pigeon-service build
```

`.github/workflows/release-sdk.yml` triggers on `sdk-v*.*.*` tag pushes, verifies the tag matches `packages/sdk/package.json`'s version, then typechecks, builds, tests, and publishes to the public npm registry.

## Licensing Note

useSend (AGPL-3.0) was studied as a reference for patterns (SES v2 wrapper, bounce classifier, idempotency middleware). No code was copied. Where a design choice was informed by useSend, it is noted in inline comments.
