import { describe, it, expect } from 'vitest';
import { normaliseInboundDomainName } from '../domain-name';

describe('normaliseInboundDomainName', () => {
  it('lower-cases, trims and drops a trailing dot', () => {
    expect(normaliseInboundDomainName('  Reply.Example.COM. ')).toEqual({ ok: true, name: 'reply.example.com' });
  });

  it.each(['', 'localhost', '*.example.com', 'user@example.com', '-bad.example.com', 'a..example.com', 'example.c0m', 'https://example.com'])(
    'rejects %j',
    (raw) => {
      expect(normaliseInboundDomainName(raw).ok).toBe(false);
    },
  );
});
