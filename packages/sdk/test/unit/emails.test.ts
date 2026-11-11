import { describe, it, expect, vi } from 'vitest';
import { PigeonClient } from '../../src/client';
import { PigeonError } from '../../src/errors';

function mockFetch(responses: Array<Response | (() => Response)>) {
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses.shift();
    if (!next) throw new Error('No more responses queued');
    return typeof next === 'function' ? next() : next;
  });
  return fn as unknown as typeof fetch;
}

describe('emails resource', () => {
  it('send() posts to /v1/emails and returns the queued id (happy path)', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ id: 'em_123', status: 'queued' }), { status: 201 }),
    );
    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy as unknown as typeof fetch,
      maxRetries: 0,
    });

    const res = await client.emails.send(
      {
        from: 'hello@example.com',
        to: ['user@example.com'],
        subject: 'Hi',
        html: '<p>hi</p>',
      },
      { idempotencyKey: 'abc-123' },
    );

    expect(res).toEqual({ id: 'em_123', status: 'queued' });

    // Inspect the captured request.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://svc.example/v1/emails');
    expect(init).toMatchObject({ method: 'POST' });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ske_test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBe('abc-123');
    expect(headers['User-Agent']).toMatch(/^@sprqvntrs\/pigeon\//);
  });

  it('send() surfaces domain_not_verified as a typed PigeonError (error path)', async () => {
    const fetchSpy = mockFetch([
      new Response(
        JSON.stringify({
          error: { code: 'domain_not_verified', message: 'Domain example.com is not verified' },
        }),
        { status: 422 },
      ),
    ]);
    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy,
      maxRetries: 0,
    });

    await expect(
      client.emails.send({
        from: 'x@example.com',
        to: ['u@example.com'],
        subject: 'Hi',
      }),
    ).rejects.toMatchObject({
      code: 'domain_not_verified',
      status: 422,
    });

    // Verify it's the real error class (for consumer `instanceof` checks).
    try {
      await client.emails.send({
        from: 'x@example.com',
        to: ['u@example.com'],
        subject: 'Hi',
      });
    } catch (e) {
      expect(e).toBeInstanceOf(PigeonError);
    }
  });
});
