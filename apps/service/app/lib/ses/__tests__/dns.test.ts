import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { buildDnsRecords, type DnsRecord } from '../dns';

const DOMAIN = 'mail.example.com';
const REGION = 'eu-central-1';
const TOKENS = ['token1abc', 'token2def', 'token3ghi'];
const TEST_DMARC_RUA = 'dmarc@test.example.com';

// Pin env var so buildDnsRecords uses a known value in these tests
beforeAll(() => {
  process.env['PIGEON_DMARC_RUA'] = TEST_DMARC_RUA;
});
afterAll(() => {
  delete process.env['PIGEON_DMARC_RUA'];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDnsRecords', () => {
  let records: DnsRecord[];

  beforeEach(() => {
    records = buildDnsRecords({ domain: DOMAIN, region: REGION, dkimTokens: TOKENS });
  });

  it('returns exactly 6 records (3 CNAME + SPF + DMARC + MX)', () => {
    expect(records).toHaveLength(6);
  });

  describe('EasyDKIM CNAME records', () => {
    it('produces one CNAME per token', () => {
      const cnames = records.filter((r) => r.type === 'CNAME');
      expect(cnames).toHaveLength(3);
    });

    it.each(TOKENS)('token %s has correct host and value', (token) => {
      const record = records.find((r) => r.host === `${token}._domainkey.${DOMAIN}`);
      expect(record).toBeDefined();
      expect(record?.type).toBe('CNAME');
      expect(record?.value).toBe(`${token}.dkim.amazonses.com`);
      expect(record?.ttl).toBe(3600);
    });

    it('notes that the record must not be proxied', () => {
      const cname = records.find((r) => r.type === 'CNAME');
      expect(cname?.notes).toMatch(/do not proxy/);
    });
  });

  describe('SPF TXT record', () => {
    it('has correct host', () => {
      const spf = records.find(
        (r) => r.type === 'TXT' && r.host === DOMAIN,
      );
      expect(spf).toBeDefined();
      expect(spf?.value).toBe('"v=spf1 include:amazonses.com ~all"');
      expect(spf?.ttl).toBe(3600);
    });

    it('notes that SPF must be merged, keyed on the MX as well as an existing record', () => {
      const spf = records.find((r) => r.type === 'TXT' && r.host === DOMAIN);
      expect(spf?.notes).toMatch(/receives mail elsewhere/);
      expect(spf?.notes).toMatch(/include:_spf\.google\.com include:amazonses\.com/);
    });
  });

  describe('DMARC TXT record', () => {
    it('uses PIGEON_DMARC_RUA env var (not per-domain inbox)', () => {
      const dmarc = records.find(
        (r) => r.type === 'TXT' && r.host === `_dmarc.${DOMAIN}`,
      );
      expect(dmarc).toBeDefined();
      expect(dmarc?.value).toBe(`"v=DMARC1; p=none; rua=mailto:${TEST_DMARC_RUA}"`);
      expect(dmarc?.ttl).toBe(3600);
    });

    it('notes that policy should start at p=none and escalate later', () => {
      const dmarc = records.find((r) => r.type === 'TXT' && r.host === `_dmarc.${DOMAIN}`);
      expect(dmarc?.notes).toMatch(/Start at p=none; escalate to quarantine\/reject/);
    });

    it('accepts explicit dmarcRua override', () => {
      const override = 'dmarc@custom.example.com';
      const overrideRecords = buildDnsRecords({
        domain: DOMAIN,
        region: REGION,
        dkimTokens: TOKENS,
        dmarcRua: override,
      });
      const dmarc = overrideRecords.find(
        (r) => r.type === 'TXT' && r.host === `_dmarc.${DOMAIN}`,
      );
      expect(dmarc?.value).toBe(`"v=DMARC1; p=none; rua=mailto:${override}"`);
    });

    it('has no rua tag when neither the override nor the env var is set', () => {
      vi.stubEnv('PIGEON_DMARC_RUA', '');
      const bareRecords = buildDnsRecords({ domain: DOMAIN, region: REGION, dkimTokens: TOKENS });
      const dmarc = bareRecords.find((r) => r.type === 'TXT' && r.host === `_dmarc.${DOMAIN}`);
      expect(dmarc?.value).toBe('"v=DMARC1; p=none"');
    });
  });

  describe('MX record', () => {
    it('has correct host, value, priority', () => {
      const mx = records.find((r) => r.type === 'MX');
      expect(mx).toBeDefined();
      expect(mx?.host).toBe(DOMAIN);
      expect(mx?.value).toBe(`feedback-smtp.${REGION}.amazonses.com`);
      expect(mx?.priority).toBe(10);
      expect(mx?.ttl).toBe(3600);
    });

    it('notes that it should be skipped when the domain already receives mail', () => {
      const mx = records.find((r) => r.type === 'MX');
      expect(mx?.notes).toMatch(/Skip if the domain already receives mail/);
    });
  });

  it('uses supplied region in MX value', () => {
    const usRecords = buildDnsRecords({ domain: DOMAIN, region: 'us-east-1', dkimTokens: TOKENS });
    const mx = usRecords.find((r) => r.type === 'MX');
    expect(mx?.value).toBe('feedback-smtp.us-east-1.amazonses.com');
  });

  it('returns empty CNAME set when no tokens provided', () => {
    const noTokenRecords = buildDnsRecords({ domain: DOMAIN, region: REGION, dkimTokens: [] });
    const cnames = noTokenRecords.filter((r) => r.type === 'CNAME');
    expect(cnames).toHaveLength(0);
    expect(noTokenRecords).toHaveLength(3); // SPF + DMARC + MX
  });
});
