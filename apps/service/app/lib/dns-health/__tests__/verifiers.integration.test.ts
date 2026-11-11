/**
 * Integration tests for DNS health verifiers.
 *
 * Same mock approach as unit tests (mocked resolver, not real DNS).
 * Focus on integration scenarios: error code propagation, mismatch detection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'node:dns/promises';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { resetSesClients } from '#app/lib/ses/client';

const mockResolveCname = vi.fn();
const mockResolveTxt = vi.fn();
const mockResolveMx = vi.fn();
vi.spyOn(dns.Resolver.prototype, 'resolveCname').mockImplementation(mockResolveCname);
vi.spyOn(dns.Resolver.prototype, 'resolveTxt').mockImplementation(mockResolveTxt);
vi.spyOn(dns.Resolver.prototype, 'resolveMx').mockImplementation(mockResolveMx);

const sesMock = mockClient(SESv2Client);

const { verifyDkimCname, verifySPF, verifySESStatus } = await import('../verifiers');

const DOMAIN_ID = 'integ-domain-001';
const DOMAIN_NAME = 'send.acme.com';
const TOKEN = 'xyztoken99';

beforeEach(() => {
  vi.clearAllMocks();
  sesMock.reset();
  resetSesClients();
  // Send-only by default: no MX, so SPF needs only the SES include.
  mockResolveMx.mockResolvedValue([]);
});

afterEach(() => {
  sesMock.reset();
  resetSesClients();
});

describe('DKIM CNAME integration scenarios', () => {
  it('ENOTFOUND on DKIM lookup → status error, actual contains "Host not found"', async () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    mockResolveCname.mockRejectedValue(err);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_1');

    expect(result.status).toBe('error');
    expect(result.actual).toContain('Host not found');
  });

  it('ENODATA on DKIM lookup → status error, actual contains "No records"', async () => {
    const err = Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    mockResolveCname.mockRejectedValue(err);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_2');

    expect(result.status).toBe('error');
    expect(result.actual).toContain('No records');
  });

  it('Mismatched CNAME target → status fail, actual contains wrong value', async () => {
    const wrongTarget = 'wrong.cname.target.com';
    mockResolveCname.mockResolvedValue([wrongTarget]);

    const result = await verifyDkimCname(DOMAIN_ID, DOMAIN_NAME, TOKEN, 'dkim_cname_3');

    expect(result.status).toBe('fail');
    expect(result.actual).toContain(wrongTarget);
  });
});

describe('SPF integration scenarios', () => {
  it('SPF TXT missing include:amazonses.com → status fail', async () => {
    mockResolveTxt.mockResolvedValue([['v=spf1 include:sendgrid.net ~all']]);

    const result = await verifySPF(DOMAIN_ID, DOMAIN_NAME);

    expect(result.status).toBe('fail');
    expect(result.actual).toContain('sendgrid.net');
    expect(result.actual).not.toContain('amazonses.com');
  });
});

describe('SES status integration scenarios', () => {
  it('SES API returns PENDING dkim status → status fail', async () => {
    sesMock.on(GetEmailIdentityCommand).resolves({
      VerifiedForSendingStatus: true,
      DkimAttributes: { Status: 'PENDING', Tokens: [], SigningEnabled: false },
    });

    const result = await verifySESStatus(DOMAIN_ID, DOMAIN_NAME);

    expect(result.status).toBe('fail');
    expect(result.actual).toContain('PENDING');
  });
});
