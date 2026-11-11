# @sprqvntrs/pigeon-cli

Admin CLI for a Pigeon email service. It manages apps, API keys, sending domains, webhooks, inbound domains and `pigeon.toml` manifests over the admin API.
The package is private for now (`"private": true`) and lives in the pigeon repo as a workspace package.

## Run it

Run it from the repo root:

```bash
pnpm --silent pigeon status                 # admin API reachable, API version, app count
pnpm --silent pigeon apps list              # --json for machine output
pnpm --silent pigeon onboard <slug> <domain> [--receives-mail]
pnpm --silent pigeon domains verify <id> --key <ske_...>
```

From any directory, point pnpm at the repo root:

```bash
pnpm -C <repo root> --silent pigeon <args>
```

`--silent` keeps pnpm's own lines out of stdout, so `--json` and `--secret-stdout` output stays clean.
Everything after `pigeon` goes to the CLI, flags included.

Relative file arguments (the manifest path, `--fleet`) resolve against the directory you ran the command from.
pnpm runs a script inside the package directory and reports the directory it was started in as `INIT_CWD`. The CLI reads that in one place (`src/lib/invocation.ts`).
`pnpm -C <dir>` makes pnpm report `<dir>` as `INIT_CWD`, so with `-C` a relative path resolves against `<dir>`. Pass an absolute path when you use `-C` from another directory.

`pnpm -C <repo root> --filter @sprqvntrs/pigeon-cli test` runs the tests. `pnpm -C <repo root> --filter @sprqvntrs/pigeon-cli typecheck` checks the types.

## Configuration

| Variable | Used for |
| -------- | -------- |
| `PIGEON_ADMIN_URL` | Base URL of the admin API. There is no default. |
| `PIGEON_ADMIN_SECRET` | The admin secret, for admin routes (apps, keys, webhooks, inbound, manifest plan and apply). |
| `PIGEON_TENANT_KEY` | A tenant `ske_` key for tenant routes (domains), instead of `--key`. |
| `PIGEON_BAY_FLEET` | Bay fleet directory for `--vault`, instead of `--fleet`. There is no default path. |

The real process environment wins.
After that the CLI reads a `.env` file in the directory you ran the command from, then in each parent directory, up to 4 levels up. It never overrides a variable that is already set, and it skips an entry with an empty value.
So the variables can live in the repo `.env`, or in the `.env` of a workspace around the repo.

## Commands

| Command | What it does |
| ------- | ------------ |
| `status` | Check the admin API and print the server API version |
| `apps list`, `apps create <name>` | List apps, or create one. App names are unique: `create` refuses a taken name and exits 1. `--force` skips only the client-side check, and the server still refuses the name (409) |
| `keys create <appId> --name <name>` | Create a tenant API key. The server shows it once |
| `domains register`, `list`, `get`, `verify` | Sending domains of one tenant. They take `--key <ske_...>` or `PIGEON_TENANT_KEY` |
| `onboard <slug> <domain>` | Create the app, a production key and the sending domain. Prints the key once and the DNS records table with a publishing note per record |
| `webhooks list`, `create`, `rotate`, `update` | Webhooks of an app |
| `inbound-domains`, `inbound` | Inbound mail domains and received mail |
| `manifest validate`, `plan`, `apply` | A `pigeon.toml` against the instance |

`onboard` runs the whole flow (duplicate-guarded app create, production key, domain registration) and prints the one-time `ske_` key plus the DNS records table.
`--receives-mail` marks the MX row SKIP and prints the merged SPF value, for a domain whose mail stays with another provider such as Google Workspace.
`onboard <slug> <domain> --vault <NAME>` writes the new tenant key to a Bay vault (`--vault-env`, default `production`; `--fleet` or `PIGEON_BAY_FLEET`) and never prints it. See the `webhooks` section for the vault rules.

### `pigeon` version check

Before every `pigeon` command that talks to the server, the CLI queries `GET /healthz` for the server API version.
It compares that number with the range in `SUPPORTED_API`. Only `manifest validate` runs offline, so it skips the check.
There are two outcomes:

- **Match.** The command runs.
- **No match, no answer or a bad answer.** The command stops, prints the reason to stderr, and exits 1.
  This covers a CLI older than the server (run `git pull` in the workspace), a server older than the CLI, a server that reports no version, a version that is not a positive whole number, and an unreachable server.
  A server that reports no version is older than this CLI. Deploy the current pigeon service, or use an older checkout of the workspace.

No flag or env var disables the check.
`pigeon status` prints the server API version and the range this CLI supports.
The service stores `PIGEON_API_VERSION` in `apps/service/app/lib/api-version.ts`. This CLI stores `SUPPORTED_API` in `packages/cli/src/lib/api-version.ts`.
Bump `SUPPORTED_API` whenever you bump `PIGEON_API_VERSION`.

### `pigeon webhooks`

```bash
pnpm --silent pigeon webhooks list <appId>
SECRET=$(pnpm --silent pigeon webhooks create <appId> --url https://example.com/hook --events email.bounced,email.complained --secret-stdout)
pnpm --silent pigeon webhooks create <appId> --url https://example.com/hook --events '*' --vault APP_WEBHOOK_SECRET
pnpm --silent pigeon webhooks rotate <appId> <webhookId> --vault APP_WEBHOOK_SECRET
```

The server shows the signing secret once, when you create or rotate a webhook.
`create` and `rotate` need exactly one secret sink. The CLI checks this before it calls the API.
`--secret-stdout` writes only the secret and a newline to stdout. Every other message goes to stderr.
`--secret-stdout` refuses to run on a terminal, and it refuses to run with `--json`.
`--vault <NAME>` stores the secret in the Bay vault. It takes `--vault-env` (default `production`) and `--fleet`.
Without `--fleet` the CLI uses `PIGEON_BAY_FLEET`. With neither set, it stops before it calls the API.
The CLI never prints the secret. `--json` output never holds it.
Supported events are `email.sent`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.received`, `contact.subscribed`, `contact.unsubscribed` and `*`.
Use `*` alone.
If a webhook for the URL already exists, `create` prints its id and does nothing else.
If the sink fails after the API call, the CLI exits with an error. The error shows the webhook id and the exact `rotate` command.
Run that command to mint a new secret. Rotating makes the old secret stop working.
`rotate` may replace a secret that already lives in the vault under that name.
`update` replaces the event list of a webhook. The signing secret does not change. `update` needs no sink:

```bash
pnpm --silent pigeon webhooks update <appId> <webhookId> --events email.bounced,email.complained,email.received
```

`rotate` and `update` are guarded writes. They read the state version of the app first and send it with the write (see "State version" below).
With `--state-version <n>` they also refuse to write unless the version they read is n.

### `pigeon inbound-domains` and `pigeon inbound`

```bash
pnpm --silent pigeon inbound-domains list <appId>
pnpm --silent pigeon inbound-domains add <appId> reply.example.com
pnpm --silent pigeon inbound list <appId> --limit 20
pnpm --silent pigeon inbound replay <appId> <inboundEmailId>
```

An inbound domain is a domain where SES receives mail for one app. Pigeon then sends `email.received` to the webhooks for that app.
`inbound-domains add` only registers the domain in pigeon. SES receiving is a separate step: run `scripts/aws-inbound.ts` in the pigeon repo. It runs as a dry run unless you pass `--apply`.
A domain belongs to one app. A second `add` of that domain fails with `409 inbound_domain_exists`.
`inbound list` shows ids, receive times and recipient counts. It never shows a sender, a subject, a body or an address.
`inbound replay` queues the `email.received` webhooks for one mail again. It fails with 404 when the record is gone. It fails with 410 when the raw mail is gone from S3.
Pigeon keeps received mail for less than 7 days. Replays work only within that window.

### `pigeon manifest`

A consumer repo declares what it needs from pigeon in a `pigeon.toml` file at its root.
The file holds needs only. It contains no instance id, no instance URL, and no secret value.
The `env` fields hold env var names, never values.
An `[[inbound]]` entry may carry an `env` field too. It names the env var that holds the inbound domain, for example `env = "SUPPORT_REPLY_DOMAIN"`.
Like every `env` name, it uses uppercase letters, digits, and underscores, and must be unique in the file.
`plan` shows it in the Env column and in `--json`.
`examples/example.pigeon.toml` is a complete manifest that uses every section of schema 1.

```bash
pnpm --silent pigeon manifest validate ./pigeon.toml
pnpm --silent pigeon manifest plan ./pigeon.toml --origin https://my-app.example.com
pnpm --silent pigeon manifest apply ./pigeon.toml --key ske_... --origin https://my-app.example.com --vault --vault-prefix MYAPP_ --yes
```

The path defaults to `./pigeon.toml` in the directory you ran the command from. With `pnpm -C <dir>` that is `<dir>`, so pass the path explicitly.
`validate` runs offline. It prints each problem with its TOML key path.
`plan` inspects the instance and changes nothing. It prints one row per declared item.
Status values are `ok`, `missing`, `unverified`, `events-differ`, `domain-not-ok`, or `not-checked`.
Items on the instance not declared in the file appear as `undeclared`. Plan never alters them.
`plan` needs only the admin secret. It reads domains and audiences through the admin API, so it needs no tenant key.
A section that `plan` could not read shows as `not-checked` with the reason. It never shows as `ok`.
A server that predates the admin domain and audience lists returns 404 for them. Only then does `plan` use the tenant key (`--key` or `PIGEON_TENANT_KEY`), and that key must belong to the app.
Without that key, those two sections show as `not-checked`.
Without `--origin`, webhooks match by URL path. With `--origin`, they match the full URL.
`apply` without `--yes` prints the planned actions and changes nothing.
`apply --yes` only creates resources. It creates the app with a production key, domains, audiences, inbound domains, and webhooks.
It adds missing events to a webhook. It never deletes resources, never removes an event, and never rotates a secret.
A new webhook requires `--origin` and `--vault`. Without them, that action is `BLOCKED`.
`apply` needs the tenant key (`--key` or `PIGEON_TENANT_KEY`) only to register a domain or create an audience, because those are tenant routes.
The key must belong to the app. Without a usable key, those actions are `BLOCKED` and the message names `--key`.
If nothing is missing in those two sections, `apply` does not require a key.
`--vault` stores each new secret in the Bay vault under its env name from the file, prefixed by `--vault-prefix`.
It reads the fleet directory from `--fleet` or `PIGEON_BAY_FLEET`.
Without `--vault`, the command prints the new API key once, just as `onboard` does.
`apply` stops at the first failed write and lists the actions that ran. Running it again on an in-sync instance writes nothing.
`plan` prints the state version of the app it read, and `--json` has it as `stateVersion`.
`apply --yes` sends that version with each write. When another client changes the app during the run, the next write is refused and `apply` exits 30.
It lists what it already applied and what it did not apply. Run `plan` again, then `apply`.
`apply --state-version <n>` refuses before the first write unless the app is still at version n. Pass the version from the `plan` you reviewed.

Exit codes for `plan` and `apply`:

| Code | Meaning |
|------|---------|
| 0 | Everything declared is `ok` |
| 10 | Changes needed, or `apply` without `--yes` has actions |
| 20 | At least one section is `not-checked`. 20 wins over 10 |
| 30 | The app changed during the run, or it is not at `--state-version`. The refused write changed nothing |
| 1 | Error: invalid file, instance not reachable, or a failed write |

`validate` exits 0 for a valid file and 1 for an invalid file.

### State version

Each app has a state version, a counter on the server. It goes up by one with each change to the configuration of the app: domains, audiences, webhooks and inbound domains.
Contacts, emails, API keys and domain verification do not change it.
The server sends the version in the `Pigeon-State-Version` header. A guarded write sends it back in `If-Match`.
When the app changed in between, the server answers 412 and changes nothing. The CLI then stops with exit code 30.

These commands are guarded: `manifest apply --yes`, `webhooks rotate` and `webhooks update`.
They exit 30 on a conflict, in every output mode. The message tells you what to run next.
A `rotate` that exits 30 did not change the secret, so the old one still works.
Exit 30 is safe to retry: read the state again, then run the command again.

`--state-version <n>` pins a command to one version. Use it when a person reviewed a plan and the write must act on exactly that state.
Without it, the command reads the version when it starts, before its first write.

A server that sends no `Pigeon-State-Version` header is too old for guarded writes. The guarded commands stop with exit code 1 before they write anything. Deploy the current pigeon service.
The server side is described in `apps/service/docs/concurrency.md`.

## Layout

```
packages/cli/
  src/cli.ts        entry point, registers the commands
  src/commands/     one file per command group
  src/lib/          the admin client, manifest parser and planner, vault and secret sinks
  tests/            node:test, run with tsx
  examples/         example.pigeon.toml
```

The tests run with `node --import tsx --test "tests/**/*.test.ts"`. Keep the quotes: an unquoted glob is expanded by the shell and silently drops files.

`pnpm test:race` runs `tests/race/race.ts`, which is not part of `pnpm test`. It starts real CLI processes in pairs against a running pigeon and checks that a conflict ends in exit 30 and never in a duplicate.
Scenario D runs two `apps create` of one new name at once: one process exits 0, the other exits 1 with the duplicate message, and exactly one app exists. Its forced rounds pass `--force`, so only the server's unique index can stop the second app.
It needs `PIGEON_ADMIN_URL` and `PIGEON_ADMIN_SECRET` of a local instance with a database you can drop. It creates a throwaway app and does not clean it up. It needs no AWS access.

