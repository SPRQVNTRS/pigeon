/**
 * Retry-aware HTTP fetcher for the SDK.
 *
 * Retry semantics (important — see spec 07 red-team notes):
 *
 * - 429 (rate-limited): always retried. The server returns this before any
 *   business logic runs, so retry is safe.
 * - 5xx: retried only when the request is "replay-safe" — either the method
 *   is GET/DELETE/HEAD, or the caller supplied an `Idempotency-Key`. Without
 *   those, a 5xx may mean "email was sent, response lost" and retrying would
 *   double-send.
 * - Network errors (pre-response): retried for all methods. No bytes committed.
 * - 4xx (not 429): never retried. The request is broken — more attempts won't
 *   fix it.
 *
 * Backoff: exponential with full jitter. Default base 200ms, max 3 retries.
 */

import { PigeonError, parseServiceError } from './errors';

export interface FetcherOptions {
  /** Full target URL. */
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'HEAD';
  /** Already-set headers. `Authorization` and `Content-Type` go here. */
  headers: Record<string, string>;
  /** Optional JSON-serialisable body. */
  body?: unknown;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Max retries for retryable failures. */
  maxRetries: number;
  /** Base delay between retries (ms); jittered, exponential. */
  retryDelayMs: number;
  /**
   * If true, the caller assumes responsibility for idempotent semantics (via
   * an Idempotency-Key header) and 5xx responses may be retried.
   */
  idempotent: boolean;
  /** Optional AbortSignal from the caller; cancels mid-flight request. */
  signal?: AbortSignal;
  /** Injected fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injected sleep (for tests). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetcherResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function sendRequest<T = unknown>(
  opts: FetcherOptions,
): Promise<FetcherResponse<T>> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;

  // GET/HEAD/DELETE are implicitly replay-safe at the HTTP level.
  const replaySafe =
    opts.idempotent ||
    opts.method === 'GET' ||
    opts.method === 'HEAD' ||
    opts.method === 'DELETE';

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= opts.maxRetries) {
    const perAttemptController = new AbortController();
    const timeoutHandle = setTimeout(() => perAttemptController.abort(), opts.timeoutMs);

    // Forward the caller's signal to the per-attempt controller.
    const onCallerAbort = () => perAttemptController.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timeoutHandle);
        throw new PigeonError({
          code: 'unknown',
          message: 'Request aborted',
          status: 0,
          cause: opts.signal.reason,
        });
      }
      opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const init: RequestInit = {
        method: opts.method,
        headers: opts.headers,
        signal: perAttemptController.signal,
      };
      if (opts.body !== undefined) {
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      }

      const res = await fetchImpl(opts.url, init);

      if (res.ok) {
        const parsed = (await parseJsonSafe(res)) as T;
        return { data: parsed, status: res.status, headers: res.headers };
      }

      // Non-2xx — decide retry vs throw.
      const retryable =
        res.status === 429 || (res.status >= 500 && res.status <= 599 && replaySafe);

      if (retryable && attempt < opts.maxRetries) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const delay = retryAfter ?? backoffDelay(attempt, opts.retryDelayMs);
        lastError = await snapshotHttpError(res);
        await sleep(delay);
        attempt++;
        continue;
      }

      throw await snapshotHttpError(res);
    } catch (err) {
      if (err instanceof PigeonError) {
        throw err;
      }

      // Abort — distinguish caller abort from timeout.
      if (isAbortError(err)) {
        const aborted = opts.signal?.aborted;
        if (aborted) {
          throw new PigeonError({
            code: 'unknown',
            message: 'Request aborted',
            status: 0,
            cause: err,
          });
        }
        // Timeout — retry if we haven't exhausted attempts.
        if (attempt < opts.maxRetries) {
          lastError = new PigeonError({
            code: 'timeout',
            message: `Request timed out after ${opts.timeoutMs}ms`,
            status: 0,
            cause: err,
          });
          await sleep(backoffDelay(attempt, opts.retryDelayMs));
          attempt++;
          continue;
        }
        throw new PigeonError({
          code: 'timeout',
          message: `Request timed out after ${opts.timeoutMs}ms`,
          status: 0,
          cause: err,
        });
      }

      // Network error (connection refused, DNS, etc.) — always retry.
      if (attempt < opts.maxRetries) {
        lastError = err;
        await sleep(backoffDelay(attempt, opts.retryDelayMs));
        attempt++;
        continue;
      }

      throw new PigeonError({
        code: 'network_error',
        message: err instanceof Error ? err.message : 'Network error',
        status: 0,
        cause: err,
      });
    } finally {
      clearTimeout(timeoutHandle);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  // Shouldn't get here, but TS wants a terminal return/throw.
  if (lastError instanceof PigeonError) {
    throw lastError;
  }
  throw new PigeonError({
    code: 'unknown',
    message: 'Retry loop exhausted',
    status: 0,
    cause: lastError,
  });
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function snapshotHttpError(res: Response): Promise<PigeonError> {
  const body = await parseJsonSafe(res);
  const reqId = res.headers.get('x-request-id') ?? undefined;
  return parseServiceError(res.status, body, reqId);
}

function backoffDelay(attempt: number, baseMs: number): number {
  // Exponential with full jitter: rand(0, base * 2^attempt), capped at 10s.
  const cap = 10_000;
  const exp = Math.min(cap, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return Math.max(0, Math.min(delta, 60_000));
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}
