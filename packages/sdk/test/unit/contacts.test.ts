import { describe, it, expect, vi } from 'vitest';
import { PigeonClient } from '../../src/client';

describe('contacts resource', () => {
  it('add() posts to the audience-scoped endpoint (happy path)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            contact: {
              id: 'con_1',
              audienceId: 'aud_1',
              email: 'user@example.com',
              firstName: 'Ada',
              status: 'subscribed',
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

    const contact = await client.contacts.add('aud_1', {
      email: 'user@example.com',
      firstName: 'Ada',
    });

    expect(contact.email).toBe('user@example.com');
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'https://svc.example/v1/audiences/aud_1/contacts',
    );
  });

  it('bulkAdd() forwards a { contacts: [...] } envelope (error path on invalid_request)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_request',
              message: 'Validation error',
              details: { contacts: ['Array must contain at least 1 element'] },
            },
          }),
          { status: 400 },
        ),
    );
    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(client.contacts.bulkAdd('aud_1', [])).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify({ contacts: [] }));
  });
});
