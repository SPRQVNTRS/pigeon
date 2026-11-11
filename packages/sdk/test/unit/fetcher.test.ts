import { describe, it, expect, vi } from 'vitest';
import { sendRequest } from '../../src/fetcher';
import { PigeonError } from '../../src/errors';

/**
 * Helper — makes a fetch impl that returns the next queued Response on each
 * invocation. Lets a test assert both the retry count and the bodies seen.
 */
function makeFetch(responses: Response[]): {
  fetch: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const fn = vi.fn(async (): Promise<Response> => {
    state.calls++;
    const next = responses.shift();
    if (!next) throw new Error('No more responses queued');
    return next;
  });
  return {
    fetch: fn as unknown as typeof fetch,
    get calls() {
      return state.calls;
    },
  };
}

const noSleep = (_ms: number) => Promise.resolve();

describe('fetcher — retry semantics', () => {
  it('returns the parsed body on a 2xx (no retry)', async () => {
    const f = makeFetch([new Response(JSON.stringify({ id: 'em_1' }), { status: 201 })]);

    const res = await sendRequest<{ id: string }>({
      url: 'https://svc/v1/emails',
      method: 'POST',
      headers: {},
      body: { subject: 'Hi' },
      timeoutMs: 1000,
      maxRetries: 3,
      retryDelayMs: 10,
      idempotent: true,
      fetchImpl: f.fetch,
      sleep: noSleep,
    });

    expect(res.status).toBe(201);
    expect(res.data).toEqual({ id: 'em_1' });
    expect(f.calls).toBe(1);
  });

  it('retries 429 until it succeeds', async () => {
    const f = makeFetch([
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const res = await sendRequest<{ ok: boolean }>({
      url: 'https://svc/v1/emails',
      method: 'POST',
      headers: {},
      timeoutMs: 1000,
      maxRetries: 3,
      retryDelayMs: 10,
      idempotent: false,
      fetchImpl: f.fetch,
      sleep: noSleep,
    });

    expect(res.data).toEqual({ ok: true });
    expect(f.calls).toBe(3);
  });

  it('retries 5xx only when the request is idempotent', async () => {
    const f = makeFetch([
      new Response(JSON.stringify({ error: { code: 'server_error', message: 'boom' } }), {
        status: 503,
      }),
    ]);

    // Non-idempotent POST → no retry, throw after first 5xx.
    await expect(
      sendRequest({
        url: 'https://svc/v1/emails',
        method: 'POST',
        headers: {},
        body: { to: 'x@y.com' },
        timeoutMs: 1000,
        maxRetries: 3,
        retryDelayMs: 10,
        idempotent: false,
        fetchImpl: f.fetch,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(PigeonError);

    expect(f.calls).toBe(1);
  });

  it('retries 5xx when Idempotency-Key makes the request replay-safe', async () => {
    const f = makeFetch([
      new Response('', { status: 503 }),
      new Response(JSON.stringify({ id: 'em_2' }), { status: 201 }),
    ]);

    const res = await sendRequest<{ id: string }>({
      url: 'https://svc/v1/emails',
      method: 'POST',
      headers: { 'Idempotency-Key': 'abc' },
      body: { to: 'x@y.com' },
      timeoutMs: 1000,
      maxRetries: 3,
      retryDelayMs: 10,
      idempotent: true,
      fetchImpl: f.fetch,
      sleep: noSleep,
    });

    expect(res.data).toEqual({ id: 'em_2' });
    expect(f.calls).toBe(2);
  });

  it('retries GET 5xx by default (idempotent at HTTP level)', async () => {
    const f = makeFetch([
      new Response('', { status: 500 }),
      new Response(JSON.stringify({ emails: [] }), { status: 200 }),
    ]);

    const res = await sendRequest<{ emails: unknown[] }>({
      url: 'https://svc/v1/emails',
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      maxRetries: 3,
      retryDelayMs: 10,
      idempotent: false,
      fetchImpl: f.fetch,
      sleep: noSleep,
    });

    expect(res.data).toEqual({ emails: [] });
    expect(f.calls).toBe(2);
  });

  it('never retries 4xx (except 429)', async () => {
    const f = makeFetch([
      new Response(
        JSON.stringify({ error: { code: 'invalid_request', message: 'bad' } }),
        { status: 400 },
      ),
    ]);

    await expect(
      sendRequest({
        url: 'https://svc/v1/emails',
        method: 'GET',
        headers: {},
        timeoutMs: 1000,
        maxRetries: 3,
        retryDelayMs: 10,
        idempotent: false,
        fetchImpl: f.fetch,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

    expect(f.calls).toBe(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const f = makeFetch([
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      new Response(
        JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
        { status: 429 },
      ),
    ]);

    await expect(
      sendRequest({
        url: 'https://svc/v1/emails',
        method: 'GET',
        headers: {},
        timeoutMs: 1000,
        maxRetries: 3,
        retryDelayMs: 10,
        idempotent: false,
        fetchImpl: f.fetch,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });

    expect(f.calls).toBe(4);
  });

  it('honours Retry-After (seconds) on 429', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = makeFetch([
      new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    await sendRequest({
      url: 'https://svc/v1/emails',
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      maxRetries: 3,
      retryDelayMs: 10,
      idempotent: false,
      fetchImpl: f.fetch,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('throws PigeonError on network failure after maxRetries', async () => {
    const err = new Error('ECONNREFUSED');
    const f = vi.fn(async () => {
      throw err;
    }) as unknown as typeof fetch;

    await expect(
      sendRequest({
        url: 'https://svc/v1/emails',
        method: 'GET',
        headers: {},
        timeoutMs: 1000,
        maxRetries: 2,
        retryDelayMs: 10,
        idempotent: false,
        fetchImpl: f,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ code: 'network_error' });
  });
});
