import { describe, it, expect, vi } from 'vitest';
import { PigeonClient, type PigeonClientOptions } from '../../src/client';
import * as publicApi from '../../src/index';

function buildFetchSpy() {
  return vi.fn(async (_url: unknown, _init?: unknown) => new Response('{}', { status: 200 }));
}

async function requestedUrl(baseUrl: string): Promise<string> {
  const fetchSpy = buildFetchSpy();
  const client = new PigeonClient({
    apiKey: 'ske_test',
    baseUrl,
    fetch: fetchSpy as unknown as typeof fetch,
    maxRetries: 0,
  });
  await client.emails.get('em_1');
  return String(fetchSpy.mock.calls[0]![0]);
}

// JS callers have no compiler, so the tests pass values the type forbids.
function buildClientUnchecked(options: Record<string, unknown>): PigeonClient {
  return new PigeonClient(options as unknown as PigeonClientOptions);
}

describe('PigeonClient baseUrl', () => {
  it('throws when baseUrl is missing', () => {
    expect(() => buildClientUnchecked({ apiKey: 'ske_test' })).toThrow(/`baseUrl` is required/);
  });

  it('throws when baseUrl is empty or blank', () => {
    expect(() => buildClientUnchecked({ apiKey: 'ske_test', baseUrl: '' })).toThrow(
      /`baseUrl` is required/,
    );
    expect(() => buildClientUnchecked({ apiKey: 'ske_test', baseUrl: '   ' })).toThrow(
      /`baseUrl` is required/,
    );
  });

  it('throws when baseUrl is not a string', () => {
    expect(() => buildClientUnchecked({ apiKey: 'ske_test', baseUrl: 42 })).toThrow(
      /`baseUrl` is required/,
    );
  });

  it('throws when baseUrl is not an absolute URL', () => {
    expect(() => buildClientUnchecked({ apiKey: 'ske_test', baseUrl: 'pigeon.example.com' })).toThrow(
      /absolute http or https URL/,
    );
    expect(() => buildClientUnchecked({ apiKey: 'ske_test', baseUrl: '/v1' })).toThrow(
      /absolute http or https URL/,
    );
  });

  it('throws when baseUrl uses a protocol other than http or https', () => {
    expect(() =>
      buildClientUnchecked({ apiKey: 'ske_test', baseUrl: 'ftp://pigeon.example.com' }),
    ).toThrow(/absolute http or https URL/);
    expect(() =>
      buildClientUnchecked({ apiKey: 'ske_test', baseUrl: 'file:///tmp/pigeon' }),
    ).toThrow(/absolute http or https URL/);
  });

  it('still requires apiKey', () => {
    expect(() => buildClientUnchecked({ baseUrl: 'https://pigeon.example.com' })).toThrow(
      /`apiKey` is required/,
    );
  });

  it('accepts http and https URLs', async () => {
    expect(await requestedUrl('https://pigeon.example.com')).toBe(
      'https://pigeon.example.com/v1/emails/em_1',
    );
    expect(await requestedUrl('http://localhost:3601')).toBe('http://localhost:3601/v1/emails/em_1');
  });

  it('removes trailing slashes', async () => {
    expect(await requestedUrl('https://pigeon.example.com///')).toBe(
      'https://pigeon.example.com/v1/emails/em_1',
    );
  });

  it('keeps a path prefix', async () => {
    expect(await requestedUrl('https://example.com/pigeon/')).toBe(
      'https://example.com/pigeon/v1/emails/em_1',
    );
  });
});

describe('public API surface', () => {
  it('exports the v3 runtime names and nothing else', () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'Audiences',
        'Contacts',
        'Domains',
        'Emails',
        'PigeonClient',
        'PigeonError',
        'parseServiceError',
        'version',
      ].sort(),
    );
  });
});
