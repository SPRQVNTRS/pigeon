/**
 * Per API key request rate limit.
 *
 * The limiter is in process: one token bucket per key in a Map. That is
 * correct because the service runs as one server process. A second server
 * process would give each key a second budget; swap the implementation
 * behind `RateLimiter` (for example for a Postgres counter) before that.
 *
 * Each bucket holds up to `ratePerSecond` tokens (at least one) and refills
 * at `ratePerSecond` tokens a second, so a key may send a burst of that many
 * requests and then that many a second. Memory is bounded: a bucket that
 * has been idle long enough to be full again is the same as no bucket, so it
 * is dropped, and the Map never holds more than `maxKeys` buckets (the least
 * recently used one goes first).
 *
 * A rate of 0 or less blocks the key: every `take` is refused with a retry
 * delay of one second, and no bucket is kept. See docs/security.md.
 */

export type RateLimitDecision = { isAllowed: true } | { isAllowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  /** Spend one token of `key`'s bucket, if it has one. A rate of 0 or less always refuses. */
  take(opts: { key: string; ratePerSecond: number }): RateLimitDecision;
  /** Number of buckets held. For tests and diagnostics. */
  size(): number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
  ratePerSecond: number;
}

/** Buckets checked for idleness on each call, so eviction cost stays constant. */
const EVICTION_SWEEP_PER_CALL = 4;
const DEFAULT_MAX_KEYS = 10_000;

/** A bucket must hold at least one token, or a rate below 1 would refuse every request. */
function capacityOf(ratePerSecond: number): number {
  return Math.max(1, ratePerSecond);
}

function refill(opts: { bucket: Bucket; nowMs: number }): number {
  const { bucket, nowMs } = opts;
  const elapsedSeconds = Math.max(0, nowMs - bucket.updatedAtMs) / 1000;
  return Math.min(capacityOf(bucket.ratePerSecond), bucket.tokens + elapsedSeconds * bucket.ratePerSecond);
}

function isFullAgain(opts: { bucket: Bucket; nowMs: number }): boolean {
  return refill(opts) >= capacityOf(opts.bucket.ratePerSecond);
}

export function createTokenBucketLimiter(opts: { now?: () => number; maxKeys?: number } = {}): RateLimiter {
  const now = opts.now ?? (() => Date.now());
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error(`maxKeys must be a positive integer, got ${maxKeys}`);

  // Map order is least recently used first: a take() moves its key to the end.
  const buckets = new Map<string, Bucket>();

  function evict(nowMs: number): void {
    let checked = 0;
    for (const [key, bucket] of buckets) {
      if (checked >= EVICTION_SWEEP_PER_CALL) break;
      checked += 1;
      if (!isFullAgain({ bucket, nowMs })) break;
      buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) break;
      buckets.delete(key);
    }
  }

  function take(takeOpts: { key: string; ratePerSecond: number }): RateLimitDecision {
    const { key, ratePerSecond } = takeOpts;
    if (Number.isNaN(ratePerSecond)) throw new Error('ratePerSecond must be a number, got NaN');
    // A rate of zero or less is the operator's way to block a key: it never
    // has a token, so every request is refused with the normal 429 answer.
    if (ratePerSecond <= 0) return { isAllowed: false, retryAfterSeconds: 1 };
    const nowMs = now();
    const previous = buckets.get(key);
    const tokens = previous ? refill({ bucket: { ...previous, ratePerSecond }, nowMs }) : capacityOf(ratePerSecond);
    buckets.delete(key);

    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAtMs: nowMs, ratePerSecond });
      evict(nowMs);
      return { isAllowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / ratePerSecond)) };
    }

    buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs, ratePerSecond });
    evict(nowMs);
    return { isAllowed: true };
  }

  return { take, size: () => buckets.size };
}
