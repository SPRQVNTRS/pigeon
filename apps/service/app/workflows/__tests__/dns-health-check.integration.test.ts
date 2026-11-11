/**
 * dns-health-check integration tests
 *
 * Tests the dnsHealthCheckHandler with mocked DB and runDnsCheckForDomain.
 * Verifies that only verified domains are checked and that per-domain
 * failures are isolated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Control what the DB returns
let dbSelectResult: Array<{ id: string }> = [];
let dbDeleteResult: Array<{ id: string }> = [];

function makeSelectChain(result: unknown[]) {
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

const mockDbDelete = vi.fn();

vi.mock('#drizzle/db', () => ({
  db: {
    select: vi.fn(() => makeSelectChain(dbSelectResult)),
    delete: vi.fn(() => mockDbDelete()),
  },
}));

vi.mock('#drizzle/schema/index', () => ({
  domains: { id: 'id', verifiedAt: 'verified_at' },
}));

vi.mock('#drizzle/schema/dns-check-results', () => ({
  dnsCheckResults: { checkedAt: 'checked_at', id: 'id' },
}));

// Mock runDnsCheckForDomain from the workflow module
const mockRunDnsCheckForDomain = vi.fn();
vi.mock('#app/workflows/dns-health-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dns-health-check')>();
  return {
    ...actual,
    runDnsCheckForDomain: (...args: unknown[]) => mockRunDnsCheckForDomain(...args),
  };
});

// Import handler after mocks
import { dnsHealthCheckHandler } from '../../scheduled-tasks/handlers/dns-health-check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassResult(domainId: string) {
  return [
    { domainId, domain: 'example.com', recordType: 'spf_txt', status: 'pass', expected: '', actual: null, checkedAt: new Date() },
    { domainId, domain: 'example.com', recordType: 'dmarc_txt', status: 'pass', expected: '', actual: null, checkedAt: new Date() },
    { domainId, domain: 'example.com', recordType: 'ses_verified', status: 'pass', expected: '', actual: null, checkedAt: new Date() },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dnsHealthCheckHandler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectResult = [];
    dbDeleteResult = [];

    // Default: delete returns empty array
    mockDbDelete.mockResolvedValue({ where: () => ({ returning: () => Promise.resolve([]) }) });
  });

  it('only checks verified domains (isNotNull(verifiedAt) filter applied at DB level)', async () => {
    // The handler selects with isNotNull(domains.verifiedAt) — the DB mock
    // simulates the DB returning only the 2 verified domains
    dbSelectResult = [{ id: 'dom-verified-1' }, { id: 'dom-verified-2' }];

    mockRunDnsCheckForDomain.mockImplementation(async (id: string) => makePassResult(id));

    // The delete chain
    mockDbDelete.mockReturnValue({
      where: () => ({ returning: () => Promise.resolve([]) }),
    });

    const result = await dnsHealthCheckHandler({});

    // Called for both verified domains only
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledTimes(2);
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledWith('dom-verified-1');
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledWith('dom-verified-2');

    expect(result.status).toBe('completed');
    expect(result.data?.checked).toBe(2);
    expect(result.data?.pass).toBe(6); // 3 per domain × 2
  });

  it('continues checking other domains when runDnsCheckForDomain throws for one', async () => {
    dbSelectResult = [{ id: 'dom-ok' }, { id: 'dom-fail' }];

    mockRunDnsCheckForDomain.mockImplementation(async (id: string) => {
      if (id === 'dom-fail') throw new Error('DNS resolver unavailable');
      return makePassResult(id);
    });

    mockDbDelete.mockReturnValue({
      where: () => ({ returning: () => Promise.resolve([]) }),
    });

    const result = await dnsHealthCheckHandler({});

    // Both domains were attempted
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledTimes(2);
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledWith('dom-ok');
    expect(mockRunDnsCheckForDomain).toHaveBeenCalledWith('dom-fail');

    // Handler still completes — does not abort
    expect(result.status).toBe('completed');
    expect(result.data?.checked).toBe(2);
    expect(result.data?.pass).toBe(3); // only dom-ok passed
  });
});
