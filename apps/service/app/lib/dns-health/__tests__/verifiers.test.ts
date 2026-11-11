import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { resetSesClients } from '#app/lib/ses/client';

// Mock dns.Resolver prototype methods so all instances share the mocks
const mockResolveCname = vi.fn();
const mockResolveTxt = vi.fn();
const mockResolveMx = vi.fn();
vi.spyOn(dns.Resolver.prototype, 'resolveCname').mockImplementation(mockResolveCname);
vi.spyOn(dns.Resolver.prototype, 'resolveTxt').mockImplementation(mockResolveTxt);
vi.spyOn(dns.Resolver.prototype, 'resolveMx').mockImplementation(mockResolveMx);

// Mock SES client
const sesMock = mockClient(SESv2Client);

const { verifyDkimCname, verifySPF, verifyDMARC, verifySESStatus } = await import(
  '../verifiers'
);

const DOMAIN_ID = 'domain-abc123';
const DOMAIN_NAME = 'mail.example.com';
const TOKEN = 'abc123token';
const REGION = 'eu-central-1';

beforeEach(() => {
  vi.clearAllMocks();
  sesMock.reset();
  resetSesClients();
  delete process.env['PIGEON_DMARC_RUA'];
  // Send-only by default: no MX, so SPF needs only the SES include.
  mockResolveMx.mockResolvedValue([]);
});

afterEach(() => {
  sesMock.reset();
  resetSesClients();
  delete process.env['PIGEON_DMARC_RUA'];
});

// ---------------------------------------------------------------------------
// verifyDkimCname
// ---------------------------------------------------------------------------

describe('verifyDkimCname', () => {
  it('returns pass when CNAME matches expected target', async () => {
    mockResolveCname.mockResolvedValue([`${TOKEN}.dkim.amazonses.com`]);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_1', REGION);

    expect(result.status).toBe('pass');
    expect(result.recordType).toBe('dkim_cname_1');
    expect(result.expected).toBe(
      `${TOKEN}._domainkey.${DOMAIN_NAME} → ${TOKEN}.dkim.amazonses.com`,
    );
    expect(result.actual).toBe(`${TOKEN}.dkim.amazonses.com`);
  });

  it('returns pass when CNAME has trailing dot (normalizes)', async () => {
    mockResolveCname.mockResolvedValue([`${TOKEN}.dkim.amazonses.com.`]);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_2', REGION);

    expect(result.status).toBe('pass');
  });

  it('returns fail when CNAME resolves to wrong target', async () => {
    mockResolveCname.mockResolvedValue(['wrong.target.com']);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_1', REGION);

    expect(result.status).toBe('fail');
    expect(result.actual).toBe('wrong.target.com');
  });

  it('returns error with label on ENOTFOUND', async () => {
    const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    mockResolveCname.mockRejectedValue(err);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_1', REGION);

    expect(result.status).toBe('error');
    expect(result.actual).toBe('Host not found (NXDOMAIN)');
  });

  it('returns error with label on ENODATA', async () => {
    const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    mockResolveCname.mockRejectedValue(err);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_3', REGION);

    expect(result.status).toBe('error');
    expect(result.actual).toBe('No records of this type');
  });

  it('returns error with label on ESERVFAIL', async () => {
    const err = Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' });
    mockResolveCname.mockRejectedValue(err);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_1', REGION);

    expect(result.status).toBe('error');
    expect(result.actual).toBe('DNS server failure');
  });
});

// ---------------------------------------------------------------------------
// verifySPF
// ---------------------------------------------------------------------------

describe('verifySPF', () => {
  it('returns pass when TXT record contains include:amazonses.com', async () => {
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
    expect(result.recordType).toBe('spf_txt');
    expect(result.actual).toContain('include:amazonses.com');
  });

  it('returns fail when no TXT record matches', async () => {
    mockResolveTxt.mockResolvedValue([['v=spf1 include:otherprovider.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('fail');
  });

  it('returns error with label on ENOTFOUND', async () => {
    const err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    mockResolveTxt.mockRejectedValue(err);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('error');
    expect(result.actual).toBe('Host not found (NXDOMAIN)');
  });

  it('passes when TXT has chunked inner arrays (joins inner chunks)', async () => {
    // resolveTxt returns string[][] — inner chunks get joined
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses', '.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
    expect(result.actual).toContain('include:amazonses.com');
  });

  it('fails a Google Workspace domain whose SPF names only SES', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'smtp.google.com', priority: 1 }]);
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('fail');
    expect(result.expected).toBe('include:amazonses.com include:_spf.google.com');
  });

  it('passes a Google Workspace domain whose SPF merges both includes', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'aspmx.l.google.com.', priority: 1 }]);
    mockResolveTxt.mockResolvedValue([
      ['v=spf1 include:_spf.google.com include:amazonses.com ~all'],
    ]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
  });

  it('asks only for SES when the MX is the SES feedback host', async () => {
    mockResolveMx.mockResolvedValue([
      { exchange: 'feedback-smtp.eu-central-1.amazonses.com', priority: 10 },
    ]);
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
    expect(result.expected).toBe('include:amazonses.com');
  });

  it('does not match a look-alike MX host', async () => {
    mockResolveMx.mockResolvedValue([{ exchange: 'mail.notgoogle.com', priority: 10 }]);
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
  });

  it('keeps the SES-only verdict when the MX lookup fails', async () => {
    mockResolveMx.mockRejectedValue(Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' }));
    mockResolveTxt.mockResolvedValue([['v=spf1 include:amazonses.com ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// verifyDMARC
// ---------------------------------------------------------------------------

describe('verifyDMARC', () => {
  const RUA = 'dmarc@dmarc.example.com';

  describe('with PIGEON_DMARC_RUA set', () => {
    beforeEach(() => {
      process.env['PIGEON_DMARC_RUA'] = RUA;
    });

    it('returns pass when DMARC TXT contains the configured rua', async () => {
      mockResolveTxt.mockResolvedValue([[`v=DMARC1; p=none; rua=mailto:${RUA}`]]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('pass');
      expect(result.recordType).toBe('dmarc_txt');
      expect(result.expected).toBe(`rua=mailto:${RUA}`);
    });

    it('returns fail when rua does not match', async () => {
      mockResolveTxt.mockResolvedValue([['v=DMARC1; p=none; rua=mailto:wrong@other.com']]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('fail');
    });

    it('returns fail when the record has no rua at all', async () => {
      mockResolveTxt.mockResolvedValue([['v=DMARC1; p=none']]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('fail');
    });

    it('returns error with label on ENODATA', async () => {
      const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('error');
      expect(result.actual).toBe('No records of this type');
    });
  });

  describe('with PIGEON_DMARC_RUA unset (beforeEach deletes it)', () => {
    it('passes a DMARC record that has no rua', async () => {
      mockResolveTxt.mockResolvedValue([['v=DMARC1; p=none']]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('pass');
      expect(result.expected).toBe('v=DMARC1');
    });

    it('passes a DMARC record that carries some rua anyway', async () => {
      mockResolveTxt.mockResolvedValue([['v=DMARC1; p=quarantine; rua=mailto:reports@owner.example.org']]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('pass');
    });

    it('fails when the domain has TXT records but none is a DMARC record', async () => {
      mockResolveTxt.mockResolvedValue([['google-site-verification=abc']]);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('fail');
    });

    it('still returns error with label on ENODATA', async () => {
      const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      mockResolveTxt.mockRejectedValue(err);

      const result = await verifyDMARC(DOMAIN_ID, DOMAIN_NAME, REGION);

      expect(result.status).toBe('error');
      expect(result.actual).toBe('No records of this type');
    });
  });
});

// ---------------------------------------------------------------------------
// verifySESStatus
// ---------------------------------------------------------------------------

describe('verifySESStatus', () => {
  it('returns pass when verifiedForSending=true and dkimStatus=SUCCESS', async () => {
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'SUCCESS', Tokens: [], SigningEnabled: true },
    });

    const result = await verifySESStatus(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('pass');
    expect(result.recordType).toBe('ses_verified');
    expect(result.actual).toContain('SUCCESS');
  });

  it('returns fail when dkimStatus is PENDING', async () => {
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'PENDING', Tokens: [], SigningEnabled: false },
    });

    const result = await verifySESStatus(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('fail');
    expect(result.actual).toContain('PENDING');
  });

  it('returns fail when verifiedForSending is false', async () => {
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: false,
      DkimAttributes: { Status: 'SUCCESS', Tokens: [], SigningEnabled: true },
    });

    const result = await verifySESStatus(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('fail');
    expect(result.actual).toContain('NOT_VERIFIED');
  });

  it('returns error when SES API throws', async () => {
    sesMock.on(GetEmailIdentityCommand).rejects(new Error('NotFoundException: identity not found'));

    const result = await verifySESStatus(DOMAIN_ID, DOMAIN_NAME, REGION);

    expect(result.status).toBe('error');
    expect(result.actual).toContain('SES API error');
  });
});
