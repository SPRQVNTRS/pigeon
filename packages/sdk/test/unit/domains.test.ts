import { describe, it, expect, vi } from 'vitest';
import { PigeonClient } from '../../src/client';

describe('domains resource', () => {
  it('create() posts { name, region } and returns { id, domain, dnsRecords } (happy path)', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'dom_1',
            domain: { id: 'dom_1', name: 'mail.example.com', dkimStatus: 'pending' },
            dnsRecords: [
              { type: 'CNAME', host: 'abc._domainkey.mail.example.com', value: 'abc.dkim.amazonses.com' },
            ],
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

    const res = await client.domains.create({ name: 'mail.example.com' });
    expect(res.id).toBe('dom_1');
    expect(res.dnsRecords).toHaveLength(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://svc.example/v1/domains');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('verify() maps a string-envelope 404 to a typed error (error path)', async () => {
    // `/v1/domains` uses the `{ error: "string" }` shape for some responses.
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Domain not found' }), { status: 404 }),
    );
    const client = new PigeonClient({
      apiKey: 'ske_test',
      baseUrl: 'https://svc.example',
      fetch: fetchSpy as unknown as typeof fetch,
      maxRetries: 0,
    });

    await expect(client.domains.verify('dom_missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
      message: 'Domain not found',
    });
  });
});
