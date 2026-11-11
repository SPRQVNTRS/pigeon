import { describe, it, expect, vi } from 'vitest';
import { PigeonClient } from '../../src/client';

describe('audiences resource', () => {
  it('create() returns the unwrapped audience (happy path)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audience: {
              id: 'aud_1',
              appId: 'app_1',
              name: 'Newsletter',
              description: null,
              createdAt: '2025-01-01T00:00:00Z',
              updatedAt: '2025-01-01T00:00:00Z',
            },
          }),
          { status: 201 },
        ),
    );

    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy as unknown as typeof fetch,
      maxRetries: 0,
    });

    const audience = await client.audiences.create({ name: 'Newsletter' });
    expect(audience.id).toBe('aud_1');
    expect(audience.name).toBe('Newsletter');
  });

  it('get() throws not_found for an unknown audience (error path)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'Audience not found' } }),
          { status: 404 },
        ),
    );
    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(client.audiences.get('aud_missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});
