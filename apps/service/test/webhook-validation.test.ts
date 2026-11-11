/**
 * Unit tests: pure webhook validation helpers
 *
 * - normaliseWebhookUrl: https only, no userinfo, no localhost, no IP literals,
 *   fragment dropped, canonical href returned
 * - normaliseEventTypes: non-empty, deduped, '*' alone or a supported subset
 * - isUniqueViolation: finds SQLSTATE 23505 on the error or its cause chain
 */

import { describe, it, expect } from 'vitest';
import { normaliseWebhookUrl } from '#app/lib/webhook-url';
import { normaliseEventTypes, SUPPORTED_WEBHOOK_EVENT_TYPES } from '#app/lib/webhook-events';
import { isUniqueViolation } from '#app/lib/pg-errors';

describe('normaliseWebhookUrl', () => {
  it('accepts an https URL and returns the canonical href', () => {
    expect(normaliseWebhookUrl('https://example.com/hooks/pigeon')).toEqual({
      ok: true,
      url: 'https://example.com/hooks/pigeon',
    });
  });

  it('lowercases the host and drops the default port', () => {
    expect(normaliseWebhookUrl('https://EXAMPLE.com:443/Hook')).toEqual({
      ok: true,
      url: 'https://example.com/Hook',
    });
  });

  it('keeps a non-default port, query and trailing slash as given', () => {
    expect(normaliseWebhookUrl('https://example.com:8443/hook/?a=1&b=2')).toEqual({
      ok: true,
      url: 'https://example.com:8443/hook/?a=1&b=2',
    });
  });

  it('drops the fragment', () => {
    expect(normaliseWebhookUrl('https://example.com/hook#section')).toEqual({
      ok: true,
      url: 'https://example.com/hook',
    });
    expect(normaliseWebhookUrl('https://example.com/hook?x=1#')).toEqual({
      ok: true,
      url: 'https://example.com/hook?x=1',
    });
  });

  it('adds the root path to a bare origin', () => {
    expect(normaliseWebhookUrl('https://example.com')).toEqual({
      ok: true,
      url: 'https://example.com/',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseWebhookUrl('  https://example.com/hook  ')).toEqual({
      ok: true,
      url: 'https://example.com/hook',
    });
  });

  it.each([
    ['empty string', ''],
    ['not a URL', 'not a url'],
    ['no scheme', 'example.com/hook'],
  ])('rejects %s', (_label, raw) => {
    const result = normaliseWebhookUrl(raw);
    expect(result.ok).toBe(false);
  });

  it.each([
    ['http', 'http://example.com/hook'],
    ['ftp', 'ftp://example.com/hook'],
    ['javascript', 'javascript:alert(1)'],
  ])('rejects non-https scheme: %s', (_label, raw) => {
    expect(normaliseWebhookUrl(raw)).toEqual({ ok: false, message: 'Must be an HTTPS URL' });
  });

  it.each([
    ['username only', 'https://user@example.com/hook'],
    ['username and password', 'https://user:pass@example.com/hook'],
    ['password only', 'https://:pass@example.com/hook'],
  ])('rejects userinfo: %s', (_label, raw) => {
    const result = normaliseWebhookUrl(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/username or password/);
  });

  it.each([
    'https://localhost/hook',
    'https://LOCALHOST:8443/hook',
    'https://localhost./hook',
    'https://api.localhost/hook',
    'https://deep.api.localhost/hook',
  ])('rejects localhost: %s', (raw) => {
    const result = normaliseWebhookUrl(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/localhost/);
  });

  it('does not reject a host that merely contains the word localhost', () => {
    expect(normaliseWebhookUrl('https://notlocalhost.com/hook').ok).toBe(true);
    expect(normaliseWebhookUrl('https://localhost.example.com/hook').ok).toBe(true);
  });

  it.each([
    'https://127.0.0.1/hook',
    'https://10.0.0.5:8443/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://[2001:db8::1]:8443/hook',
    'https://[::ffff:127.0.0.1]/hook',
    // The WHATWG parser rewrites these numeric forms to dotted IPv4.
    'https://2130706433/hook',
    'https://0x7f.1/hook',
    'https://127.1/hook',
    'https://1.2.3.4./hook',
  ])('rejects IP literal: %s', (raw) => {
    const result = normaliseWebhookUrl(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/IP address/);
  });
});

describe('normaliseEventTypes', () => {
  it('accepts the wildcard alone', () => {
    expect(normaliseEventTypes(['*'])).toEqual({ ok: true, eventTypes: ['*'] });
  });

  it('accepts every supported event type', () => {
    expect(normaliseEventTypes([...SUPPORTED_WEBHOOK_EVENT_TYPES])).toEqual({
      ok: true,
      eventTypes: [...SUPPORTED_WEBHOOK_EVENT_TYPES],
    });
  });

  it('dedupes while keeping first-seen order', () => {
    expect(normaliseEventTypes(['email.sent', 'email.bounced', 'email.sent'])).toEqual({
      ok: true,
      eventTypes: ['email.sent', 'email.bounced'],
    });
  });

  it('collapses a duplicated wildcard to one', () => {
    expect(normaliseEventTypes(['*', '*'])).toEqual({ ok: true, eventTypes: ['*'] });
  });

  it('rejects an empty list', () => {
    expect(normaliseEventTypes([]).ok).toBe(false);
  });

  it('rejects the wildcard mixed with other types', () => {
    const result = normaliseEventTypes(['*', 'email.sent']);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/cannot be combined/);
  });

  it('rejects unknown event types and names them', () => {
    const result = normaliseEventTypes(['email.sent', 'email.exploded']);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('email.exploded');
  });
});

describe('isUniqueViolation', () => {
  it('detects code 23505 on the error itself', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('detects code 23505 on the cause (Drizzle wraps driver errors)', () => {
    const inner = Object.assign(new Error('dup'), { code: '23505' });
    expect(isUniqueViolation(new Error('Failed query', { cause: inner }))).toBe(true);
  });

  it('ignores other Postgres errors', () => {
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
  });

  it.each([null, undefined, 'x', 42, new Error('plain')])('returns false for %s', (value) => {
    expect(isUniqueViolation(value)).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
