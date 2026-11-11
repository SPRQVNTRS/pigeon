/**
 * What each deployment setting resolves to while its variable is unset, and
 * what it reads when set. The defaults are the neutral or secure values: a
 * change here changes what a fresh deployment publishes in DNS, tags its logs
 * with, throttles, or delivers to.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveDmarcRua,
  resolveRateLimitMode,
  resolveServiceName,
  resolveWebhookPrivateHosts,
  resolveWebhookPrivateTargets,
} from '../deployment-settings';
import { buildDnsRecords } from '#app/lib/ses/dns';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveDmarcRua', () => {
  it('has no address while PIGEON_DMARC_RUA is unset', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', '');
    expect(resolveDmarcRua()).toBeUndefined();
  });

  it('treats a blank value as unset', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', '   ');
    expect(resolveDmarcRua()).toBeUndefined();
  });

  it('reads PIGEON_DMARC_RUA when it is set', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', 'dmarc@dmarc.example.com');
    expect(resolveDmarcRua()).toBe('dmarc@dmarc.example.com');
  });

  it('trims the value', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', ' dmarc@dmarc.example.com ');
    expect(resolveDmarcRua()).toBe('dmarc@dmarc.example.com');
  });

  it.each([
    ['no at sign', 'dmarc.example.com'],
    ['no domain dot', 'dmarc@localhost'],
    ['a mailto: prefix, which the record builder adds itself', 'mailto:dmarc@dmarc.example.com'],
    ['a second address', 'a@example.com,b@example.com'],
    ['a record tag injected after a semicolon', 'dmarc@example.com;p=reject'],
    ['whitespace inside', 'dmarc @example.com'],
  ])('throws on %s', (_label, value) => {
    vi.stubEnv('PIGEON_DMARC_RUA', value);
    expect(() => resolveDmarcRua()).toThrow(/PIGEON_DMARC_RUA must be an email address/);
  });

  it('puts no rua tag in the DNS records while unset', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', '');
    const records = buildDnsRecords({ domain: 'mail.example.com', region: 'eu-central-1', dkimTokens: ['t1'] });
    const dmarc = records.find((record) => record.host === '_dmarc.mail.example.com');
    expect(dmarc?.value).toBe('"v=DMARC1; p=none"');
  });

  it('reaches the DNS records the service hands to a tenant when set', () => {
    vi.stubEnv('PIGEON_DMARC_RUA', 'dmarc@dmarc.example.com');
    const records = buildDnsRecords({ domain: 'mail.example.com', region: 'eu-central-1', dkimTokens: ['t1'] });
    const dmarc = records.find((record) => record.host === '_dmarc.mail.example.com');
    expect(dmarc?.value).toBe('"v=DMARC1; p=none; rua=mailto:dmarc@dmarc.example.com"');
  });
});

describe('resolveServiceName', () => {
  it('resolves to pigeon while PIGEON_SERVICE_NAME is unset', () => {
    vi.stubEnv('PIGEON_SERVICE_NAME', '');
    expect(resolveServiceName()).toBe('pigeon');
  });

  it('prefers PIGEON_SERVICE_NAME when it is set', () => {
    vi.stubEnv('PIGEON_SERVICE_NAME', 'my-pigeon');
    expect(resolveServiceName()).toBe('my-pigeon');
  });
});

describe('resolveRateLimitMode', () => {
  it('resolves to enforce while PIGEON_RATE_LIMIT is unset', () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', '');
    expect(resolveRateLimitMode()).toBe('enforce');
  });

  it.each(['enforce', 'off', ' ENFORCE '])('reads PIGEON_RATE_LIMIT=%s', (value) => {
    vi.stubEnv('PIGEON_RATE_LIMIT', value);
    expect(resolveRateLimitMode()).toBe(value.trim().toLowerCase());
  });

  it('throws on any other value', () => {
    vi.stubEnv('PIGEON_RATE_LIMIT', 'on');
    expect(() => resolveRateLimitMode()).toThrow('PIGEON_RATE_LIMIT must be one of enforce, off, got "on"');
  });
});

describe('resolveWebhookPrivateTargets', () => {
  it('resolves to deny while PIGEON_WEBHOOK_PRIVATE_TARGETS is unset', () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', '');
    expect(resolveWebhookPrivateTargets()).toBe('deny');
  });

  it.each(['deny', 'allow'])('reads PIGEON_WEBHOOK_PRIVATE_TARGETS=%s', (value) => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', value);
    expect(resolveWebhookPrivateTargets()).toBe(value);
  });

  it('throws on any other value', () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_TARGETS', 'block');
    expect(() => resolveWebhookPrivateTargets()).toThrow(/PIGEON_WEBHOOK_PRIVATE_TARGETS must be one of deny, allow/);
  });
});

describe('resolveWebhookPrivateHosts', () => {
  it('is empty while PIGEON_WEBHOOK_PRIVATE_HOSTS is unset or blank', () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', '');
    expect(resolveWebhookPrivateHosts()).toEqual(new Set());
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', ' , ,');
    expect(resolveWebhookPrivateHosts()).toEqual(new Set());
  });

  it('reads a comma-separated list, trimmed, with empty segments ignored', () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', ' hooks.example.com ,,internal.example.org,receiver ');
    expect(resolveWebhookPrivateHosts()).toEqual(new Set(['hooks.example.com', 'internal.example.org', 'receiver']));
  });

  it('stores each name in lower case without its trailing dot', () => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', 'Hooks.Example.COM.,internal.example.org');
    expect(resolveWebhookPrivateHosts()).toEqual(new Set(['hooks.example.com', 'internal.example.org']));
  });

  it.each([
    ['https://hooks.example.com', 'a URL with a scheme'],
    ['hooks.example.com:8443', 'a host with a port'],
    ['hooks.example.com/path', 'a URL with a path'],
    ['*.example.com', 'a wildcard'],
    ['.example.com', 'a domain suffix'],
    ['100.64.0.9', 'an IP address'],
    ['::1', 'an IP address'],
    ['[fd00::5]', 'an IP address'],
    ['2130706433', 'an IP address'],
    ['0x7f.1', 'an IP address'],
    ['hooks_1.example.com', 'not a host name'],
    ['-hooks.example.com', 'not a host name'],
  ])('throws on the entry %s (%s), and names the setting and the entry', (entry, problem) => {
    vi.stubEnv('PIGEON_WEBHOOK_PRIVATE_HOSTS', `hooks.example.com,${entry}`);
    expect(() => resolveWebhookPrivateHosts()).toThrow(
      `PIGEON_WEBHOOK_PRIVATE_HOSTS must list exact host names such as hooks.example.com, but "${entry}" is ${problem}`,
    );
  });
});
