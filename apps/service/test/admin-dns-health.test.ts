/**
 * Unit tests: Admin UI — DNS health badge + check routes (M76/04)
 *
 * Tests:
 * - domain list loader: badge state derived correctly from mixed pass/fail results
 * - domain list loader: unchecked state for domain with no dns_check_results rows
 * - domain detail loader: returns all 6 record types even for unchecked domain
 * - dns-check action: calls enqueueDnsCheck with correct domainId, returns { jobId }
 * - dns-check/:jobId loader: returns mapped status for queued/running/completed/failed/not_found
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import type { Route as DomainsRoute } from '../app/routes/+types/admin.apps.$appId.domains';
import type { Route as DomainDetailRoute } from '../app/routes/+types/admin.apps.$appId.domains.$domainId';
import type { Route as DnsCheckRoute } from '../app/routes/+types/admin.apps.$appId.domains.$domainId.dns-check';
import type { Route as DnsCheckPollRoute } from '../app/routes/+types/admin.apps.$appId.domains.$domainId.dns-check.$jobId';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any route import
// ---------------------------------------------------------------------------

const mockListDomains = vi.fn();
const mockGetDomain = vi.fn();
const mockGetAppById = vi.fn().mockResolvedValue({ id: 'app_test_1', name: 'Test App', createdAt: new Date() });
const mockEnqueueDnsCheck = vi.fn();
const mockGetDnsCheckJobStatus = vi.fn();
const mockDbExecute = vi.fn();

// DNS check results DB query mock (used by domain list + detail loaders)
const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
const mockDbWhere = vi.fn();
const mockDbOrderBy = vi.fn();

vi.mock('#app/services/domain-service', () => ({
  listDomains: (...args: unknown[]) => mockListDomains(...args),
  getDomain: (...args: unknown[]) => mockGetDomain(...args),
}));

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mockGetAppById(...args),
}));

vi.mock('#app/workflows/dns-health-check', () => ({
  enqueueDnsCheck: (...args: unknown[]) => mockEnqueueDnsCheck(...args),
  getDnsCheckJobStatus: (...args: unknown[]) => mockGetDnsCheckJobStatus(...args),
}));

// Mock the orchestrator to return a fake boss
const mockBoss = { send: vi.fn(), getJobById: vi.fn() };
vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => mockBoss }),
}));

vi.mock('#config', () => ({
  CONFIG: {
    aws: {
      region: 'eu-central-1',
      dmarcRua: 'dmarc@dmarc.example.com',
    },
  },
}));

// Mock drizzle db: the domain list loader uses db.execute() for the window query,
// and the domain detail loader uses db.select().from().where().orderBy()
vi.mock('#drizzle/db', () => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => mockDbOrderBy()),
  };
  chain.from.mockImplementation(() => chain);
  chain.where.mockImplementation(() => chain);

  return {
    db: {
      execute: (...args: unknown[]) => mockDbExecute(...args),
      select: vi.fn(() => chain),
    },
  };
});

// Mock drizzle/schema — only need the table references to exist
vi.mock('#drizzle/schema/dns-check-results', () => ({
  dnsCheckResults: { domainId: 'domain_id', recordType: 'record_type', checkedAt: 'checked_at' },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADMIN_USER = {
  id: 1,
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
  password: 'hashed',
  deactivated: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeAdminContext() {
  const store = new Map<object, unknown>();
  store.set(userContext, ADMIN_USER);
  return { get: (key: object) => store.get(key) };
}

const MOCK_DOMAIN = {
  id: 'domain_test_1',
  appId: 'app_test_1',
  name: 'example.com',
  region: 'eu-central-1',
  dkimSelector: 'pigeon',
  dkimTokens: ['token1abc', 'token2def', 'token3ghi'],
  spfStatus: 'pending',
  dkimStatus: 'pending',
  dmarcStatus: 'pending',
  mxStatus: 'pending',
  verifiedAt: null,
  lastVerificationError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CHECKED_AT = new Date('2026-05-21T10:00:00Z');

// ---------------------------------------------------------------------------
// Route imports (after mocks are set up)
// ---------------------------------------------------------------------------

const { loader: listLoader } = await import('../app/routes/admin.apps.$appId.domains');
const { loader: detailLoader } = await import('../app/routes/admin.apps.$appId.domains.$domainId');
const { action: dnsCheckAction } = await import(
  '../app/routes/admin.apps.$appId.domains.$domainId.dns-check'
);
const { loader: dnsCheckPollLoader } = await import(
  '../app/routes/admin.apps.$appId.domains.$domainId.dns-check.$jobId'
);

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.select chain returns empty array
  mockDbOrderBy.mockResolvedValue([]);
  // Default: db.execute returns empty rows for list loader
  mockDbExecute.mockResolvedValue({ rows: [] });
});

// =============================================================================
// Domain list loader — health badge
// =============================================================================

describe('GET /admin/apps/:appId/domains — DNS health badge', () => {
  it('returns healthy badge when all statuses are pass', async () => {
    mockListDomains.mockResolvedValue([MOCK_DOMAIN]);

    // Window-function query returns 6 rows all with status=pass
    mockDbExecute.mockResolvedValue({
      rows: [
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'verified', checked_at: CHECKED_AT },
      ],
    });

    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);

    expect(result.domains[0].health.badgeState).toBe('healthy');
    expect(result.domains[0].health.lastCheckedAt).toEqual(CHECKED_AT);
  });

  it('returns failing badge when at least one status is fail', async () => {
    mockListDomains.mockResolvedValue([MOCK_DOMAIN]);

    mockDbExecute.mockResolvedValue({
      rows: [
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'fail', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
      ],
    });

    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);

    expect(result.domains[0].health.badgeState).toBe('failing');
  });

  it('returns degraded badge when there are errors but no fails', async () => {
    mockListDomains.mockResolvedValue([MOCK_DOMAIN]);

    mockDbExecute.mockResolvedValue({
      rows: [
        { domain_id: 'domain_test_1', status: 'pass', checked_at: CHECKED_AT },
        { domain_id: 'domain_test_1', status: 'error', checked_at: CHECKED_AT },
      ],
    });

    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);

    expect(result.domains[0].health.badgeState).toBe('degraded');
  });

  it('returns unchecked for domain with no dns_check_results rows', async () => {
    mockListDomains.mockResolvedValue([MOCK_DOMAIN]);
    // db.execute returns empty — no rows for this domain
    mockDbExecute.mockResolvedValue({ rows: [] });

    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);

    expect(result.domains[0].health.badgeState).toBe('unchecked');
    expect(result.domains[0].health.lastCheckedAt).toBeNull();
  });
});

// =============================================================================
// Domain detail loader — DNS health table
// =============================================================================

describe('GET /admin/apps/:appId/domains/:domainId — DNS health table', () => {
  it('returns all 6 record types even when some have no results', async () => {
    mockGetDomain.mockResolvedValue(MOCK_DOMAIN);

    // Simulate only 2 of 6 record types checked
    mockDbOrderBy.mockResolvedValue([
      {
        id: 'row_1',
        domainId: 'domain_test_1',
        domain: 'example.com',
        recordType: 'spf_txt',
        status: 'pass',
        expected: 'v=spf1 include:amazonses.com ~all',
        actual: 'v=spf1 include:amazonses.com ~all',
        checkedAt: CHECKED_AT,
      },
      {
        id: 'row_2',
        domainId: 'domain_test_1',
        domain: 'example.com',
        recordType: 'dmarc_txt',
        status: 'fail',
        expected: 'v=DMARC1; p=none',
        actual: null,
        checkedAt: CHECKED_AT,
      },
    ]);

    const req = new Request('http://localhost/admin/apps/app_test_1/domains/domain_test_1');
    const result = await detailLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DomainDetailRoute.LoaderArgs);

    expect(result.dnsHealth).toHaveLength(6);

    // spf_txt is present with status pass
    const spfRow = result.dnsHealth.find((r) => r.recordType === 'spf_txt');
    expect(spfRow?.status).toBe('pass');

    // dmarc_txt is present with status fail
    const dmarcRow = result.dnsHealth.find((r) => r.recordType === 'dmarc_txt');
    expect(dmarcRow?.status).toBe('fail');

    // dkim_cname_1 was never checked — status should be null
    const dkimRow = result.dnsHealth.find((r) => r.recordType === 'dkim_cname_1');
    expect(dkimRow?.status).toBeNull();
    expect(dkimRow?.checkedAt).toBeNull();
  });

  it('returns all 6 record types with null status when domain has never been checked', async () => {
    mockGetDomain.mockResolvedValue(MOCK_DOMAIN);
    mockDbOrderBy.mockResolvedValue([]);

    const req = new Request('http://localhost/admin/apps/app_test_1/domains/domain_test_1');
    const result = await detailLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DomainDetailRoute.LoaderArgs);

    expect(result.dnsHealth).toHaveLength(6);
    for (const row of result.dnsHealth) {
      expect(row.status).toBeNull();
      expect(row.checkedAt).toBeNull();
    }
  });
});

// =============================================================================
// DNS check action — enqueue
// =============================================================================

describe('POST /admin/apps/:appId/domains/:domainId/dns-check (enqueue action)', () => {
  it('calls enqueueDnsCheck with correct domainId and returns { jobId }', async () => {
    mockEnqueueDnsCheck.mockResolvedValue('job_abc123');

    const req = new Request(
      'http://localhost/admin/apps/app_test_1/domains/domain_test_1/dns-check',
      { method: 'POST' },
    );
    const response = await dnsCheckAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DnsCheckRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);

    const body = await (response as Response).json() as { jobId: string };
    expect(body.jobId).toBe('job_abc123');

    // enqueueDnsCheck is called with (boss, domainId)
    expect(mockEnqueueDnsCheck).toHaveBeenCalledWith(mockBoss, 'domain_test_1');
  });
});

// =============================================================================
// DNS check poll loader — status mapping
// =============================================================================

describe('GET /admin/apps/:appId/domains/:domainId/dns-check/:jobId (poll loader)', () => {
  const cases: Array<[string, 'queued' | 'running' | 'completed' | 'failed' | 'not_found']> = [
    ['queued', 'queued'],
    ['running', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['not_found', 'not_found'],
  ];

  it.each(cases)('returns status %s when getDnsCheckJobStatus returns %s', async (input, expected) => {
    mockGetDnsCheckJobStatus.mockResolvedValue(input);

    const req = new Request(
      `http://localhost/admin/apps/app_test_1/domains/domain_test_1/dns-check/job_abc123`,
    );
    const response = await dnsCheckPollLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1', jobId: 'job_abc123' },
    } as unknown as DnsCheckPollRoute.LoaderArgs);

    expect(response).toBeInstanceOf(Response);
    const body = await (response as Response).json() as { status: string };
    expect(body.status).toBe(expected);

    expect(mockGetDnsCheckJobStatus).toHaveBeenCalledWith(mockBoss, 'job_abc123');
  });
});
