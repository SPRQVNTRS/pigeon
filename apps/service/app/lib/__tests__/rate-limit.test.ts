import { describe, it, expect } from 'vitest';
import { createTokenBucketLimiter } from '../rate-limit';

function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe('createTokenBucketLimiter', () => {
  it('allows a burst of ratePerSecond requests, then refuses with a retry delay', () => {
    const time = clock();
    const limiter = createTokenBucketLimiter({ now: time.now });
    const decisions = Array.from({ length: 4 }, () => limiter.take({ key: 'k', ratePerSecond: 3 }));
    expect(decisions.slice(0, 3)).toEqual([{ isAllowed: true }, { isAllowed: true }, { isAllowed: true }]);
    expect(decisions[3]).toEqual({ isAllowed: false, retryAfterSeconds: 1 });
  });

  it('refills at ratePerSecond tokens a second', () => {
    const time = clock();
    const limiter = createTokenBucketLimiter({ now: time.now });
    for (let i = 0; i < 2; i += 1) limiter.take({ key: 'k', ratePerSecond: 2 });
    expect(limiter.take({ key: 'k', ratePerSecond: 2 }).isAllowed).toBe(false);
    time.advance(500);
    expect(limiter.take({ key: 'k', ratePerSecond: 2 }).isAllowed).toBe(true);
    expect(limiter.take({ key: 'k', ratePerSecond: 2 }).isAllowed).toBe(false);
  });

  it('rounds the retry delay up to whole seconds for a slow rate', () => {
    const time = clock();
    const limiter = createTokenBucketLimiter({ now: time.now });
    limiter.take({ key: 'k', ratePerSecond: 0.25 });
    expect(limiter.take({ key: 'k', ratePerSecond: 0.25 })).toEqual({ isAllowed: false, retryAfterSeconds: 4 });
  });

  it('keeps one budget per key', () => {
    const limiter = createTokenBucketLimiter({ now: clock().now });
    expect(limiter.take({ key: 'a', ratePerSecond: 1 }).isAllowed).toBe(true);
    expect(limiter.take({ key: 'a', ratePerSecond: 1 }).isAllowed).toBe(false);
    expect(limiter.take({ key: 'b', ratePerSecond: 1 }).isAllowed).toBe(true);
  });

  it('drops a bucket once it is idle long enough to be full again', () => {
    const time = clock();
    const limiter = createTokenBucketLimiter({ now: time.now });
    for (let i = 0; i < 100; i += 1) limiter.take({ key: `idle-${i}`, ratePerSecond: 10 });
    expect(limiter.size()).toBe(100);
    time.advance(1_000);
    for (let i = 0; i < 40; i += 1) limiter.take({ key: 'busy', ratePerSecond: 10 });
    expect(limiter.size()).toBeLessThan(100);
    for (let i = 0; i < 100; i += 1) limiter.take({ key: 'busy', ratePerSecond: 10 });
    expect(limiter.size()).toBe(1);
  });

  it('never holds more than maxKeys buckets', () => {
    const limiter = createTokenBucketLimiter({ now: clock().now, maxKeys: 50 });
    for (let i = 0; i < 1_000; i += 1) limiter.take({ key: `k-${i}`, ratePerSecond: 5 });
    expect(limiter.size()).toBe(50);
  });

  it('refuses every request of a key whose rate is 0 or negative, with a retry delay of one second', () => {
    const time = clock();
    const limiter = createTokenBucketLimiter({ now: time.now });
    for (const ratePerSecond of [0, -1, -0.5]) {
      expect(limiter.take({ key: 'blocked', ratePerSecond })).toEqual({ isAllowed: false, retryAfterSeconds: 1 });
      time.advance(60_000);
      expect(limiter.take({ key: 'blocked', ratePerSecond })).toEqual({ isAllowed: false, retryAfterSeconds: 1 });
    }
    expect(limiter.size()).toBe(0);
  });

  it('lets a key through again once its rate is raised above 0', () => {
    const limiter = createTokenBucketLimiter({ now: clock().now });
    expect(limiter.take({ key: 'k', ratePerSecond: 0 }).isAllowed).toBe(false);
    expect(limiter.take({ key: 'k', ratePerSecond: 2 }).isAllowed).toBe(true);
  });

  it('throws on a rate that is NaN', () => {
    const limiter = createTokenBucketLimiter();
    expect(() => limiter.take({ key: 'k', ratePerSecond: Number.NaN })).toThrow(/number/);
  });
});
