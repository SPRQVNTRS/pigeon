# Changelog

All notable changes to `@sprqvntrs/pigeon` (the SDK) are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [3.0.2] - 2026-11-11

### Changed

- No code change. This is the first version that the release workflow publishes with npm Trusted Publishing. The package on npm now has a provenance statement, which shows the commit and the workflow that built it.

## [3.0.1] - 2026-11-11

### Fixed

- 3.0.0 was published with entry points that name `src/index.ts`, a file that is not in the package. 3.0.1 has the correct entry points. No API change. 3.0.0 is deprecated.

### Changed

- `main`, `module`, `types` and `exports` in `package.json` now point at `dist` directly. Before, they pointed at `src` and `publishConfig` replaced them, which only `pnpm publish` does. Every publish tool now ships the same manifest.
- A unit test packs the package with `pnpm pack` and with `npm pack`. It checks every entry point in the tarball and imports the package from the extracted files. `prepublishOnly` runs this test before any publish.

## [3.0.0] - 2026-11-11

### Breaking

- `baseUrl` is now required. The built-in default host is removed. The `PigeonClient` constructor throws when `baseUrl` is missing, empty, or not an absolute http or https URL. Trailing slashes are still removed.
- `SprqvntrsEmail`, `SprqvntrsEmailOptions`, `SprqvntrsEmailError` and `SprqvntrsEmailErrorOptions` are removed. Use `PigeonClient`, `PigeonClientOptions`, `PigeonError` and `PigeonErrorOptions`.
- The package moves from GitHub Packages to the public npm registry. The name stays `@sprqvntrs/pigeon`. Install it with `npm install @sprqvntrs/pigeon`. You no longer need an `.npmrc` entry or a token. Remove the `@sprqvntrs:registry=https://npm.pkg.github.com` line from your `.npmrc`.

### Added

- Optional `retain_body` field on `SendEmailRequest`. Send `retain_body: false` to keep no html, text or headers in Pigeon once the send is over (see the data retention page of the service docs).
- The tarball now includes `CHANGELOG.md`.

### Changed

- `version.ts` reports `3.0.0`. It said `2.0.0` in the published 2.1.0 package, so the user agent string was wrong. A unit test keeps it equal to `package.json`.
- Licence is `MIT` (was `UNLICENSED`) and the package carries a `LICENSE` file.
- README examples use `PigeonClient` and `PigeonError`. `instanceof SprqvntrsEmailError` never matched, because the SDK throws `PigeonError`.

### Migration from 2.x

```ts
// before
const client = new PigeonClient({ apiKey });
// after
const client = new PigeonClient({ apiKey, baseUrl: process.env.PIGEON_BASE_URL! });
```

- Pass the base URL of your own Pigeon service as `baseUrl`.
- Replace `new SprqvntrsEmail(...)` with `new PigeonClient(...)`, and `SprqvntrsEmailError` with `PigeonError`.
- Remove the GitHub Packages registry line from `.npmrc`, then run `npm install @sprqvntrs/pigeon@3`.

## [2.1.0] - 2026-07-04

### Fixed

- `DnsRecord` type declared a `name` field, but the API has always returned `host`. The type now matches the wire format.

### Added

- Optional `notes` field on `DnsRecord`: per-record publishing guidance returned by the API (SPF merge rule, skip-MX-when-domain-already-receives-mail, Cloudflare DNS-only warning for DKIM CNAMEs, DMARC escalation path).

## [2.0.0] - 2026-05-02

Package renamed `@sprqvntrs/email` → `@sprqvntrs/pigeon` (service renamed email-service → pigeon at the code layer).

## [0.2.0]

Pre-changelog release - see git history / `sdk-v0.2.0` tag. (API paths aligned to canonical `/v1/*`, was `/api/v1/*`.)

## [0.1.0]

Pre-changelog release - see git history / `sdk-v0.1.0` tag.
