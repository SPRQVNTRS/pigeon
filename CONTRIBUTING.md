# Contributing

Thanks for your interest in Pigeon. This is a small project with one maintainer, so please keep changes focused.

## Before you start

- For anything larger than a small fix, open an issue first and describe what you want to change. This saves you work on a change that may not fit.
- Report security problems through [SECURITY.md](./SECURITY.md), never in a public issue.

## Setup

Follow the [Quickstart in the README](./README.md#quickstart-local). Pigeon needs Node 22 or newer, pnpm 11.3.0 and a PostgreSQL database.

## Checks to run before a pull request

Run these from the repository root:

```bash
pnpm typecheck
pnpm --filter @sprqvntrs/pigeon-service build
pnpm --filter @sprqvntrs/pigeon-service test
pnpm --filter @sprqvntrs/pigeon test
pnpm --filter @sprqvntrs/pigeon-cli test
```

The service tests need a Postgres database, set through the `DB_*` variables (and `DB_PORT` if it is not on 5432). There is no linter. `pnpm format` runs Prettier on the service.

The repository has a pre-push gate in `.githooks/pre-push`. It runs the typecheck and the service build. Enable it with `git config core.hooksPath .githooks`. The hook runs `pnpm` on your machine, through corepack if `pnpm` is not on your PATH. It does not run the tests.

## Pull requests

- One topic per pull request.
- Use conventional commit messages, for example `feat:`, `fix:`, `docs:`, `refactor:` and `chore:`.
- Add or update tests with your change. Tests sit next to the code they cover, in `__tests__` folders (the service also has tests in `apps/service/test/`).
- Update the docs when behavior changes.
- If you change a database table, generate a migration with `pnpm --filter @sprqvntrs/pigeon-service drizzle:generate`. Check that the new entry's `when` value in `apps/service/drizzle/migrations/meta/_journal.json` is greater than the one before it. Never edit `when` by hand.

## License

By contributing, you agree that your contribution is licensed under the MIT license in [LICENSE](./LICENSE).
