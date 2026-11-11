# Security rules

This page lists the guards that protect a Pigeon deployment. Two of them have a
setting. Both default to the secure value while the variable is unset, so a new
deployment is safe without any setting. Loosen one only on purpose, and set the
variable to say so (see `.env.example`).

## Admin UI: the admin role

Every route under `/admin` needs a signed-in user with the `admin` role. Other
roles (`manager`, `editor`) get 403.

The check runs as middleware in the admin UI layout (`app/routes/_admin-ui.tsx`):
first `authMiddleware` (the session), then `adminRoleMiddleware` (the role).
Middleware runs for every request that matches the layout. A check in the layout
loader is not enough, for three reasons:

- React Router runs child loaders in parallel with the layout loader.
- A `.data` request can name one child loader and skip the layout loader.
- An action runs with no loader before it.

A new child route needs no check of its own. `test/admin-ui-authorization.test.ts`
reads every route under the layout from `app/routes.ts`. It fails when a loader
or action runs for an anonymous user or a non-admin.

The admin REST API (`/v1/admin/*`) is separate. It takes the `ADMIN_SECRET`
bearer token in `adminAuthMiddleware`.

## API keys: rate limit (`PIGEON_RATE_LIMIT`)

Each API key has `rate_limit_per_second` (default 10). With
`PIGEON_RATE_LIMIT=enforce`, the API key middleware gives each key a token
bucket. The bucket allows a burst of that many requests, then refills at that
many requests per second. A request over the limit gets `429` with
`{ "error": "rate_limited" }` and a `Retry-After` header in seconds. No route
code runs for it. A NULL column means no limit for that key.

A value of 0 or less blocks the key. Under `enforce` every request on that key
gets the same `429` answer with `Retry-After: 1`, and the value never recovers
on its own. This is a deliberate rule, not an error: set the column to 0 to cut
off one key without deleting it, and raise it again to let the key through. The
database does not forbid these values. Under `off` the column is not read.

| Value | Effect |
|-------|--------|
| `enforce` | Limits every key that has a value. This is the value when the variable is not set (see `app/config/deployment-settings.ts`). |
| `off` | Never limits. Set it on purpose, for example behind a gateway that limits already. |

The limiter keeps its state in memory. That is correct because the service runs
as one server process. A second process would give every key a second budget.
To run more than one process, replace the implementation behind the
`RateLimiter` interface in `app/lib/rate-limit.ts`. Memory stays bounded: a key
that is idle long enough to refill is dropped, and the limiter holds at most
10,000 keys.

Check that each consumer sends at its key's rate. A consumer that sends a burst
of single calls gets 429. The SDK retries 429 and waits for `Retry-After`. Raise
`rate_limit_per_second` on that key, or set it to NULL. A deployment whose
consumers cannot stay under their rate sets `PIGEON_RATE_LIMIT=off`.

## Webhook targets (`PIGEON_WEBHOOK_PRIVATE_TARGETS`)

A tenant chooses the webhook URL, and the worker sends a POST to it from inside
your network. These rules stop a URL from reaching internal services.

Always, under both values:

- The scheme is `http` or `https`. A new webhook or a URL change needs `https`.
- The URL has no user name or password.

With `PIGEON_WEBHOOK_PRIVATE_TARGETS=deny`, every address the host resolves to
must be public. One non-public address refuses the host. These ranges are
non-public:

- loopback: 127.0.0.0/8, ::1
- private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- link-local: 169.254.0.0/16 (this includes the cloud metadata address), fe80::/10
- carrier-grade NAT: 100.64.0.0/10
- unique local: fc00::/7
- unspecified, multicast and reserved: 0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4, ::/96, ff00::/8
- the IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) forms of these

An IP literal in the URL gets the same check. The URL parser turns decimal,
octal and hex forms such as `2130706433` or `0x7f.1` into `127.0.0.1` first.

The check runs twice:

1. At registration and on a URL change (admin API and admin UI). A refused URL
   gets 422 or a form error.
2. On every delivery attempt, on both queues (`webhook.deliver` and
   `webhook.deliver.inbound`). The worker resolves the host one time, checks
   every address, and connects only to an address it checked. So a DNS answer
   cannot change between the check and the connect. The worker does not follow
   redirects: a 3xx counts as a failed attempt.

A refused target ends that delivery after one attempt. The answer does not
change on a retry, so the worker does not retry it. It sets the webhook's
`last_failure_at`, logs the reason, and stores the reason as the job output.
The job shows as completed, with the reason as its message. The webhook stays
enabled. A network error, a timeout or a non-2xx answer is still retried.

### Private hosts (`PIGEON_WEBHOOK_PRIVATE_HOSTS`)

Some networks use split DNS. A public host name then resolves to a private
address from inside the container. Under `deny`, such a webhook is refused.
`allow` fixes that, but it opens every private address to every tenant.

`PIGEON_WEBHOOK_PRIVATE_HOSTS` is the narrow fix. It is a comma-separated list
of exact host names:

```
PIGEON_WEBHOOK_PRIVATE_HOSTS=hooks.example.com,internal.example.org
```

Under `deny`, a webhook URL whose host is in the list may resolve to a private
network address. These ranges count as private network:

- 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- carrier-grade NAT: 100.64.0.0/10
- unique local: fc00::/7
- the IPv4-mapped (::ffff:a.b.c.d) forms of these

Every other rule still applies to a listed host:

- Loopback, link-local (this includes the cloud metadata address),
  unspecified, multicast, reserved and NAT64 addresses are still refused. One
  such answer refuses the host.
- The scheme and credential rules still apply.
- The worker still pins the checked address and does not follow redirects.
- An IP literal in the URL is never covered by the list.

The list matches the whole host name. Case does not matter, and a trailing dot
is ignored. `hooks.example.com` does not cover `api.hooks.example.com` or
`example.com`. Write an internationalized name in its `xn--` form. An entry
with a scheme, a port, a path, a wildcard (`*.example.com`), a leading dot
(`.example.com`) or an IP address is an error. The error names the setting and
the entry. Spaces around entries and empty entries are ignored. Unset or empty
means no host is listed.

Under `allow` the list has no effect.

| Value | Effect |
|-------|--------|
| `deny` | Refuses non-public targets. This is the value when the variable is not set (see `app/config/deployment-settings.ts`). |
| `allow` | Lets private targets through. Delivery uses `fetch` and follows redirects. The scheme and credential rules still apply. Set it on purpose, for example for receivers on a private network or on localhost during development. |

Under `deny`, a webhook that points at a private address (a container alias, a
VPN address) is refused at registration, and its deliveries fail. Point it at a
public https URL. If the host is yours and resolves to a private network
address only inside your network, add it to `PIGEON_WEBHOOK_PRIVATE_HOSTS`.
Set `allow` only when every tenant may reach your private network.

## SNS webhooks

`POST /v1/webhooks/ses`, `/v1/webhooks/dmarc` and `/v1/webhooks/inbound` take
no API key. Each one accepts only its configured topic (`SES_SNS_TOPIC_ARN`,
`DMARC_SNS_TOPIC_ARN`, `INBOUND_SNS_TOPIC_ARN`). Without the variable, the route
answers 503. Each route runs its checks in this order:

1. The topic ARN must match, else 403. This check comes before any fetch. AWS
   signs messages for every account, so a valid signature alone proves nothing.
2. The SNS signature must be valid, else 400. The signing certificate URL must
   be an https SNS host.
3. A subscription confirmation is fetched only when its `SubscribeURL` is https,
   on the default port, with no user name or password, and on an
   `sns.<region>.amazonaws.com` host. Else the route answers 400.

The shared predicate is `app/lib/sns/subscribe-url.ts`.

## API key hashes

The service stores a SHA-256 hash of each API key. No response contains it.
Every route and admin page that returns key rows builds them with
`toPublicApiKey` (`app/lib/api-key-public.ts`). This function returns a fixed
list of fields.
