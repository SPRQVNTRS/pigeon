# @sprqvntrs/pigeon

TypeScript SDK for the Pigeon email service. Typed HTTP client with
retries, idempotency forwarding, and a single error class so consumers
can `switch (err.code)`.

## Install

```bash
npm install @sprqvntrs/pigeon
```

The package is on the public npm registry. It needs no token and no `.npmrc` entry.

## Quickstart

```ts
import { PigeonClient } from '@sprqvntrs/pigeon';

const email = new PigeonClient({
  apiKey: process.env.PIGEON_API_KEY!,
  // The base URL of your Pigeon service, for example
  // https://pigeon.example.com. Required. The constructor throws when it is
  // missing or is not an absolute http or https URL.
  baseUrl: process.env.PIGEON_BASE_URL!,
});

// Send a transactional email. The idempotency key lets the SDK safely
// retry on 5xx without risking a double-send.
const { id, status } = await email.emails.send(
  {
    from: 'Hello <hello@mail.example.com>',
    to: ['user@example.com'],
    subject: 'Welcome',
    html: '<p>Thanks for signing up.</p>',
  },
  { idempotencyKey: crypto.randomUUID() },
);
```

### Mail that must not be kept

Pigeon stores each mail's html, text and headers. For a mail whose body is a secret (a password reset link, a sign-in code), send `retain_body: false`:

```ts
await email.emails.send({
  from: 'Hello <hello@mail.example.com>',
  to: ['user@example.com'],
  subject: 'Reset your password',
  html: `<a href="${link}">Reset</a>`,
  retain_body: false,
});
```

Once the send is over (sent, suppressed or failed for good), Pigeon blanks the stored body and deletes the queue job. The recipient, subject and status stay. The field defaults to `true`. The wire name is snake_case, unlike `replyTo`. Details are in the data retention page of the service docs.

## API surface

```ts
email.emails.send(body, opts?)     // POST /v1/emails
email.emails.get(id, opts?)        // GET  /v1/emails/:id
email.emails.list(params?, opts?)  // GET  /v1/emails

email.domains.create(body, opts?)  // POST   /v1/domains
email.domains.list(opts?)          // GET    /v1/domains
email.domains.get(id, opts?)       // GET    /v1/domains/:id
email.domains.verify(id, opts?)    // POST   /v1/domains/:id/verify
email.domains.delete(id, opts?)    // DELETE /v1/domains/:id

email.audiences.create(body, opts?)       // POST   /v1/audiences
email.audiences.list(opts?)               // GET    /v1/audiences
email.audiences.get(id, opts?)            // GET    /v1/audiences/:id
email.audiences.update(id, body, opts?)   // PATCH  /v1/audiences/:id
email.audiences.delete(id, opts?)         // DELETE /v1/audiences/:id

email.contacts.add(audienceId, body, opts?)                       // POST   /contacts
email.contacts.bulkAdd(audienceId, contacts, opts?)               // POST   /contacts/bulk
email.contacts.list(audienceId, params?, opts?)                   // GET    /contacts
email.contacts.get(audienceId, contactId, opts?)                  // GET    /contacts/:id
email.contacts.update(audienceId, contactId, body, opts?)         // PATCH  /contacts/:id
email.contacts.remove(audienceId, contactId, opts?)               // DELETE /contacts/:id (unsubscribe)
```

## Error handling

Every failure throws a `PigeonError`, never a raw `Error`, never
a `Response`. The `.code` is a stable discriminator you can `switch` on.

```ts
import { PigeonError } from '@sprqvntrs/pigeon';

try {
  await email.emails.send({ ... });
} catch (err) {
  if (!(err instanceof PigeonError)) throw err;

  switch (err.code) {
    case 'domain_not_verified':
      // Domain isn't verified for sending, so link the user to domain setup.
      break;
    case 'rate_limited':
      // The SDK already retried. If you see this, back off at the app level.
      break;
    case 'idempotency_key_collision':
      // Same idempotency key, different body, so surface as a client bug.
      break;
    case 'unauthorized':
      // Bad / revoked API key.
      break;
    default:
      throw err;
  }
}
```

Error codes returned by the service today:

| code                           | status | meaning                                                         |
| ------------------------------ | ------ | --------------------------------------------------------------- |
| `unauthorized`                 | 401/403| missing / invalid / revoked API key                             |
| `invalid_request`              | 400/422| request body failed validation                                  |
| `not_found`                    | 404    | resource doesn't exist or isn't scoped to this app              |
| `method_not_allowed`           | 405    | wrong HTTP method                                               |
| `domain_not_verified`          | 422    | sender domain's DKIM isn't verified                             |
| `idempotency_key_collision`    | 409    | key replayed with a different body                              |
| `rate_limited`                 | 429    | back off                                                        |
| `server_error`                 | 5xx    | anything else coming out of the service                         |

Plus three client-side-only codes the SDK raises itself:

| code              | meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `network_error`   | fetch threw before we got a response (DNS, connect reset)  |
| `timeout`         | request exceeded `timeoutMs`                               |
| `unknown`         | fallback, should never happen                              |

Forward compatibility: the SDK keeps an open `ErrorCode` union so if
the service adds a new code (say, `quota_exceeded`) before you bump
the SDK, `err.code` will still carry the raw string and your `default:`
branch will catch it.

## Retries

The SDK retries on 429 and, when the request is replay-safe, on 5xx.
A request is replay-safe if:

- the method is GET / HEAD / DELETE (idempotent at the HTTP level), or
- you passed `idempotencyKey` on a write method.

Without those, the SDK will **not** retry 5xx, because an email may have
been sent before the response got lost, and blind retry would
double-send it.

Configurable knobs on the constructor:

```ts
new PigeonClient({
  apiKey,
  baseUrl: 'https://pigeon.example.com',
  timeoutMs: 30_000,     // per-attempt timeout
  maxRetries: 3,         // max retry count (0 disables retry)
  retryDelayMs: 200,     // exponential-backoff base, jittered
});
```

Backoff: exponential with full jitter (`rand(0, base * 2^attempt)`),
capped at 10 s. The SDK also respects a `Retry-After` header on 429
when the server sends one.

## Idempotency

For `emails.send`, `domains.create`, `audiences.create`, `contacts.add`,
`contacts.bulkAdd`, and the `update` methods, pass
`{ idempotencyKey }` in the options bag. The SDK forwards it as the
`Idempotency-Key` header. The service stores the request for 24 h and
replays the original response on duplicate calls.

```ts
await email.emails.send(body, { idempotencyKey: crypto.randomUUID() });
```

Generate a fresh key per logical request, not per retry, and reuse it
if the consumer itself retries at a higher level.

## Cancellation

Every method accepts `{ signal }` so you can plug in an `AbortController`:

```ts
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 5000);
await email.emails.send(body, { signal: ctl.signal, idempotencyKey: '...' });
```

## Testing against a local service

```bash
export CONTRACT_TEST_BASE_URL=http://localhost:3601
export CONTRACT_TEST_API_KEY=ske_...
pnpm --filter @sprqvntrs/pigeon test:contract
```

Unit tests (default `pnpm test`) use mocked `fetch` and require no
service.
