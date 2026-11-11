/**
 * dns-health-check workflow — unit tests
 *
 * Tests runDnsCheckForDomain, enqueueDnsCheck, and getDnsCheckJobStatus.
 * All DB, verifier, and persist dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const selectResults: unknown[][] = [];
function makeSelectChain() {
  const result = selectResults.shift() ?? [];
  const awaitable = Promise.resolve(result);
  return {
    from: () => ({
      where: () => ({
        then: awaitable.then.bind(awaitable),
        catch: awaitable.catch.bind(awaitable),
      }),
    }),
  };
}

vi.mock('#drizzle/db', () => ({
  db: {
    select: vi.fn(() => makeSelectChain()),
    delete: vi.fn(),
  },
}));

vi.mock('#drizzle/schema/index', () => ({
  domains: { id: 'id', verifiedAt: 'verified_at' },
}));

vi.mock('#drizzle/schema/dns-check-results', () => ({
  dnsCheckResults: { checkedAt: 'checked_at', id: 'id' },
}));

const mockVerifyDkimCname = vi.fn();
const mockVerifySPF = vi.fn();
const mockVerifyDMARC = vi.fn();
const mockVerifySESStatus = vi.fn();

vi.mock('#app/lib/dns-health/verifiers', () => ({
  verifyDkimCname: (...args: unknown[]) => mockVerifyDkimCname(...args),
  verifySPF: (...args: unknown[]) => mockVerifySPF(...args),
  verifyDMARC: (...args: unknown[]) => mockVerifyDMARC(...args),
  verifySESStatus: (...args: unknown[]) => mockVerifySESStatus(...args),
}));

const mockPersistDnsCheckResults = vi.fn();
vi.mock('#app/lib/dns-health/persist', () => ({
  persistDnsCheckResults: (...args: unknown[]) => mockPersistDnsCheckResults(...args),
}));

// Import after mocks are in place
import { runDnsCheckForDomain, enqueueDnsCheck, getDnsCheckJobStatus } from '../dns-health-check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckResult(overrides = {}) {
  return {
    domainId: 'dom1',
    domain: 'example.com',
    recordType: 'spf_txt',
    status: 'pass',
    expected: 'include:amazonses.com',
    actual: 'v=spf1 include:amazonses.com ~all',
    checkedAt: new Date(),
    ...overrides,
  };
}

const DOMAIN_WITH_TOKENS = {
  id: 'dom1',
  name: 'example.com',
  dkimTokens: ['abc', 'def', 'ghi'],
  region: 'eu-central-1',
};

const DOMAIN_NO_TOKENS = {
  id: 'dom2',
  name: 'nodkim.com',
  dkimTokens: null,
  region: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDnsCheckForDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.length = 0;
    mockPersistDnsCheckResults.mockResolvedValue(undefined);
  });

  it('calls 6 verifiers (3 DKIM + SPF + DMARC + SES) for domain with 3 tokens', async () => {
    selectResults.push([DOMAIN_WITH_TOKENS]);

    const dkimResult = makeCheckResult({ recordType: 'dkim_cname_1', status: 'pass' });
    mockVerifyDkimCname.mockResolvedValue(dkimResult);
    mockVerifySPF.mockResolvedValue(makeCheckResult({ recordType: 'spf_txt', status: 'pass' }));
    mockVerifyDMARC.mockResolvedValue(makeCheckResult({ recordType: 'dmarc_txt', status: 'pass' }));
    mockVerifySESStatus.mockResolvedValue(makeCheckResult({ recordType: 'ses_verified', status: 'pass' }));

    const results = await runDnsCheckForDomain('dom1');

    expect(mockVerifyDkimCname).toHaveBeenCalledTimes(3);
    expect(mockVerifyDkimCname).toHaveBeenCalledWith('dom1', 'example.com', 'abc', 'dkim_cname_1', 'eu-central-1');
    expect(mockVerifyDkimCname).toHaveBeenCalledWith('dom1', 'example.com', 'def', 'dkim_cname_2', 'eu-central-1');
    expect(mockVerifyDkimCname).toHaveBeenCalledWith('dom1', 'example.com', 'ghi', 'dkim_cname_3', 'eu-central-1');
    expect(mockVerifySPF).toHaveBeenCalledTimes(1);
    expect(mockVerifyDMARC).toHaveBeenCalledTimes(1);
    expect(mockVerifySESStatus).toHaveBeenCalledTimes(1);

    expect(results).toHaveLength(6);
    expect(mockPersistDnsCheckResults).toHaveBeenCalledWith(results);
  });

  it('calls only SPF + DMARC + SES (no DKIM) for domain with null dkimTokens', async () => {
    selectResults.push([DOMAIN_NO_TOKENS]);

    mockVerifySPF.mockResolvedValue(makeCheckResult({ status: 'pass' }));
    mockVerifyDMARC.mockResolvedValue(makeCheckResult({ status: 'pass' }));
    mockVerifySESStatus.mockResolvedValue(makeCheckResult({ status: 'pass' }));

    const results = await runDnsCheckForDomain('dom2');

    expect(mockVerifyDkimCname).not.toHaveBeenCalled();
    expect(mockVerifySPF).toHaveBeenCalledTimes(1);
    expect(mockVerifyDMARC).toHaveBeenCalledTimes(1);
    expect(mockVerifySESStatus).toHaveBeenCalledTimes(1);

    expect(results).toHaveLength(3);
    expect(mockPersistDnsCheckResults).toHaveBeenCalledWith(results);
  });

  it('marks a result as error when one verifier throws, others succeed (Promise.allSettled isolation)', async () => {
    selectResults.push([DOMAIN_NO_TOKENS]);

    mockVerifySPF.mockRejectedValue(new Error('Network failure'));
    mockVerifyDMARC.mockResolvedValue(makeCheckResult({ recordType: 'dmarc_txt', status: 'pass' }));
    mockVerifySESStatus.mockResolvedValue(makeCheckResult({ recordType: 'ses_verified', status: 'pass' }));

    const results = await runDnsCheckForDomain('dom2');

    expect(results).toHaveLength(3);
    const errored = results.filter((r) => r.status === 'error');
    expect(errored).toHaveLength(1);
    expect(errored[0]!.actual).toContain('Network failure');

    const passed = results.filter((r) => r.status === 'pass');
    expect(passed).toHaveLength(2);

    // Should still persist all results including the error one
    expect(mockPersistDnsCheckResults).toHaveBeenCalledWith(results);
  });
});

describe('enqueueDnsCheck', () => {
  it('calls boss.send with correct queue name and domainId, returns jobId', async () => {
    const boss = {
      send: vi.fn().mockResolvedValue('job-123'),
    } as unknown as Parameters<typeof enqueueDnsCheck>[0];

    const jobId = await enqueueDnsCheck(boss, 'dom1');

    expect(boss.send).toHaveBeenCalledWith(
      'dns-health-check-adhoc',
      { domainId: 'dom1' },
      { retryLimit: 0 },
    );
    expect(jobId).toBe('job-123');
  });

  it('throws when boss.send returns null', async () => {
    const boss = {
      send: vi.fn().mockResolvedValue(null),
    } as unknown as Parameters<typeof enqueueDnsCheck>[0];

    await expect(enqueueDnsCheck(boss, 'dom1')).rejects.toThrow(
      'Failed to enqueue dns-health-check-adhoc job',
    );
  });
});

describe('getDnsCheckJobStatus', () => {
  it('maps pg-boss states to correct status strings', async () => {
    const cases = [
      { state: 'created', expected: 'queued' },
      { state: 'retry', expected: 'queued' },
      { state: 'active', expected: 'running' },
      { state: 'completed', expected: 'completed' },
      { state: 'failed', expected: 'failed' },
      { state: 'cancelled', expected: 'failed' },
    ] as const;

    for (const { state, expected } of cases) {
      const boss = {
        getJobById: vi.fn().mockResolvedValue({ state }),
      } as unknown as Parameters<typeof getDnsCheckJobStatus>[0];

      const status = await getDnsCheckJobStatus(boss, 'job-abc');
      expect(status).toBe(expected);
    }
  });

  it('returns not_found when job does not exist', async () => {
    const boss = {
      getJobById: vi.fn().mockResolvedValue(null),
    } as unknown as Parameters<typeof getDnsCheckJobStatus>[0];

    const status = await getDnsCheckJobStatus(boss, 'nonexistent');
    expect(status).toBe('not_found');
  });
});
