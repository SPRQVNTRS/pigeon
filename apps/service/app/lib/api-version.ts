/**
 * The version of the pigeon HTTP contract, as a positive integer.
 *
 * Bump it by hand whenever the tenant API or the admin API changes in a way a
 * client must know about. Do not bump it for internal changes.
 *
 * The server reports it in the `apiVersion` field of the `/healthz` body and in
 * the `Pigeon-Api-Version` response header. The admin CLI in this repo,
 * `packages/cli/src/lib/api-version.ts`, holds the range of versions it
 * supports (`SUPPORTED_API`). Change both files in the same step.
 *
 * Version 1 included the `apiVersion` field of `/healthz` and the admin lists
 * `GET /v1/admin/apps/:id/domains` and `GET /v1/admin/apps/:id/audiences`.
 * Version 2 removed the deprecated `X-Sprqvntrs-*` webhook headers. Webhook
 * deliveries carry only the `Pigeon-*` names.
 *
 * Next to it, routes that read or change one app's configuration carry the
 * `Pigeon-State-Version` header and accept `If-Match` (lib/state-version.ts,
 * docs/concurrency.md). That contract is additive: an old client ignores the
 * header and sends no If-Match, so it did not need a version bump.
 */
export const PIGEON_API_VERSION = 2;

export const PIGEON_API_VERSION_HEADER = 'Pigeon-Api-Version';
