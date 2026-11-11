# Concurrent configuration changes

Two clients can update one app at the same time. Pigeon gives each app a counter, called the state version. A client can make writes conditional on this value.

## The state version

`apps.state_version` starts at 0. It increments by one with each configuration change:

| Counts | Does not count |
|--------|----------------|
| Domains: create, delete | Domain verification status, written by the worker |
| Audiences: create, update, delete | Contacts |
| Webhooks: create, update, rotate the secret, delete | Webhook delivery times |
| Inbound domains: create, update, remove | API keys, emails, suppressions |

No route deletes a webhook, or updates or removes an inbound domain, yet. Any future route for these actions must also increment the version.
The change and the increment happen in one transaction. All configuration writes run through `withConfigChange` in `app/models/config-change.server.ts`.

## Reading it

These responses return the `Pigeon-State-Version: <n>` header:

- `GET /v1/admin/apps/:id`. The body also includes `app.stateVersion`.
- `GET /v1/admin/apps/:id/domains`, `/audiences`, `/webhooks` and `/inbound-domains`.
- `GET /v1/domains` and `GET /v1/audiences`, with a tenant key.
- `POST /v1/admin/apps`. A new app starts at 0.
- Every successful configuration write. It returns the new version.

A list route reads the version before it reads the items. The returned list is never older than the reported version.

## Writing with If-Match

A configuration write can include `If-Match: "<n>"`. The quotes are optional.

- If the app is still at version n, the write succeeds. The response returns the new version, n + 1.
- If the app changed, the server returns `412` and alters nothing:

  ```json
  { "error": "state_version_mismatch", "expected": 3, "current": 5 }
  ```

  The 412 response sets `Pigeon-State-Version` to the current version. Re-read the configuration before retrying.
- A malformed `If-Match` returns `400` with `{ "error": "invalid_if_match", "message": "..." }`. Malformed values include `*`, weak tags, lists, or anything other than a single integer.
- A write without `If-Match` runs unconditionally. Existing clients keep working.

These writes accept `If-Match`:

- `POST /v1/domains`, `DELETE /v1/domains/:id`
- `POST /v1/audiences`, `PATCH /v1/audiences/:id`, `DELETE /v1/audiences/:id`
- `POST /v1/admin/apps/:id/webhooks`, `PATCH /v1/admin/apps/:id/webhooks/:webhookId`, `POST /v1/admin/apps/:id/webhooks/:webhookId/rotate`
- `POST /v1/admin/apps/:id/inbound-domains`

The admin UI forms omit the version. Their writes are unconditional, but they still increment the version.

## How the server checks it

Inside the transaction, the write executes `UPDATE apps SET state_version = state_version + 1 WHERE id = $app AND state_version = $expected`. If no row updates, the version is stale. The transaction rolls back and the server returns 412.

That UPDATE locks the app row until commit, serializing configuration writes for the app. When two writes submit the same version, the second write blocks on the lock, finds the incremented version, and receives a 412.

Writes with external calls, such as creating an SES identity for a domain, make those calls after the check. A stale write never calls SES. If the SES call fails, the transaction rolls back and preserves the original state.

## In the CLI

The admin CLI fetches the version and sends `If-Match` on guarded writes. A 412 status causes it to exit with code 30. See "State version" in `packages/cli/README.md`.
