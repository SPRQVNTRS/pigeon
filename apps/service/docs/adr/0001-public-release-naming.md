# 0001. Public release naming

## Status

Accepted, 2026-11-09.

2026-11-11: the legacy `X-Sprqvntrs-*` headers were removed and `PIGEON_API_VERSION` moved to 2.

## Context

Pigeon is a transactional email service on AWS SES with a TypeScript SDK. It was built for its owner's own sites and still carries the owner's brand in header names, the SDK default URL, a deprecated alias and a licence field. A later public release needs these names to be swappable, and the live consumers must not break on the way.

## Decision

1. **Webhook headers.** Deliveries carry `Pigeon-Signature`, `Pigeon-Timestamp`, `Pigeon-Event` and `Pigeon-Delivery-Id`. Until the release the service also sends `X-Sprqvntrs-Signature`, `X-Sprqvntrs-Event` and `X-Sprqvntrs-Delivery-Id` with identical values. The old names are deprecated and are removed at the release as a counted API version bump. The signature algorithm and the signed payload do not change.
2. **SDK package name.** It stays `@sprqvntrs/pigeon`. At the release it moves from GitHub Packages to the public npm registry under the same name. No rename.
3. **SDK default base URL.** The default that points at the owner's public host is removed in SDK v3, and `baseUrl` becomes required. It is not removed earlier, because that breaks live consumers.
4. **Env var names.** The canonical names are `PIGEON_API_KEY` and `PIGEON_BASE_URL`. A consumer that uses other names is not forced to rename. Its `pigeon.toml` manifest declares the names it uses in the `[env]` section.
5. **Deprecated SDK alias.** `SprqvntrsEmail` (with its options and error types) is removed in SDK v3, at the release.
6. **Licence.** MIT everywhere. The SDK `package.json` and the SDK folder follow the repository `LICENSE`.
7. **Release form.** A fresh public repository with one squashed commit. The private history stays private.

## What is already prepared

- `app/lib/webhook-headers.ts` holds every outbound webhook header name and the one function that builds the header set. The legacy names sit in one marked section at the end of that file.
- Tests cover both header sets, equal values, and signature verification with the new names. The legacy test block is marked for deletion.
- `docs/webhooks.md` documents the `Pigeon-*` names and the deprecation.
- The SDK is licensed `MIT` and ships a `LICENSE` file. `src/version.ts` matches `package.json`, and a unit test keeps them equal.
- `SprqvntrsEmail`, its option and error types, and the default base URL are marked `@deprecated` ("removed in v3"). The README uses the new names.

## Swap checklist at release

1. In `app/lib/webhook-headers.ts`, delete the section between the LEGACY BEGIN and END markers. Delete the marked legacy test block in `app/workflows/__tests__/webhook-deliver.test.ts`.
2. Bump `PIGEON_API_VERSION` in `app/lib/api-version.ts` and the supported range in the admin CLI together.
3. Update `docs/webhooks.md`: remove the deprecated names section.
4. SDK v3: remove `SprqvntrsEmail`, `SprqvntrsEmailOptions`, `SprqvntrsEmailError` and `SprqvntrsEmailErrorOptions`. Remove `DEFAULT_BASE_URL` and make `baseUrl` required. Update the changelog and bump the major version.
5. Publish SDK v3 to the public npm registry: change `publishConfig` and the release workflow.
6. Check the licence fields: root `LICENSE`, the SDK `package.json`, the SDK `LICENSE`, and any service `package.json`.
7. Move operations runbooks and owner-specific values out of the public tree. This covers the setup, inbound mail and local end-to-end docs, the AWS script README, the agent instruction files, the deploy manifest, the example env file and the default sender and DMARC addresses in config.
8. Squash into a fresh public repository with one commit. Do not push the old history.
9. Before step 1 is deployed, update each consumer: read `Pigeon-Signature` for webhooks, pass `baseUrl`, replace `SprqvntrsEmail` with `PigeonClient`, and move to the v3 package.
10. Update the repository URLs and the `keywords` in the SDK `package.json`.
