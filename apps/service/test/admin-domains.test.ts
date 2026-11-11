/**
 * Unit tests: Admin UI — Domains CRUD loaders and actions
 *
 * Tests:
 * - list loader: returns domains for appId
 * - list loader: empty array
 * - create action: valid FQDN → redirect with ?created=1
 * - create action: invalid domain → field errors
 * - create action: duplicate domain → field error
 * - detail loader: returns domain by ID
 * - detail loader: throws 404 for unknown domainId
 * - verify action: enqueues job → redirect with ?verified=1
 * - verify action: domain not found → 404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import type { Route as DomainsRoute } from '../app/routes/+types/admin.apps.$appId.domains';
import type { Route as DomainsNewRoute } from '../app/routes/+types/admin.apps.$appId.domains.new';
import type { Route as DomainDetailRoute } from '../app/routes/+types/admin.apps.$appId.domains.$domainId';
import type { Route as DomainVerifyRoute } from '../app/routes/+types/admin.apps.$appId.domains.$domainId.verify';

// Mocks must be declared before route imports

const mockListDomains = vi.fn();
const mockCreateDomain = vi.fn();
const mockGetDomain = vi.fn();
const mockEnqueueVerification = vi.fn();
const mockGetAppById = vi.fn().mockResolvedValue({ id: 'app_test_1', name: 'Test App', createdAt: new Date() });

vi.mock('#app/services/domain-service', () => ({
  listDomains: mockListDomains,
  createDomain: mockCreateDomain,
  getDomain: mockGetDomain,
  enqueueVerification: mockEnqueueVerification,
}));

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mockGetAppById(...args),
}));

vi.mock('#app/services/workflows.server', () => ({
  getOrchestrator: () => ({ getBoss: () => ({ send: vi.fn() }) }),
}));

const mockDbExecute = vi.fn().mockResolvedValue({ rows: [] });
const mockDbQueryChain = {
  from: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
};
// Wire up the builder chain so each method returns the next in the chain,
// with orderBy resolving to an empty array (no DNS check rows yet)
mockDbQueryChain.orderBy.mockResolvedValue([]);
mockDbQueryChain.where.mockReturnValue(mockDbQueryChain);
mockDbQueryChain.from.mockReturnValue(mockDbQueryChain);

vi.mock('#drizzle/db', () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: vi.fn().mockReturnValue(mockDbQueryChain),
  },
}));

vi.mock('#drizzle/schema/dns-check-results', () => ({
  dnsCheckResults: {},
}));

vi.mock('#config', () => ({
  CONFIG: {
    aws: {
      region: 'eu-central-1',
      dmarcRua: 'dmarc@dmarc.example.com',
    },
  },
}));

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

const { loader: listLoader } = await import('../app/routes/admin.apps.$appId.domains');
const { loader: newLoader, action: createAction } = await import(
  '../app/routes/admin.apps.$appId.domains.new'
);
const { loader: detailLoader } = await import(
  '../app/routes/admin.apps.$appId.domains.$domainId'
);
const { action: verifyAction, loader: verifyLoader } = await import(
  '../app/routes/admin.apps.$appId.domains.$domainId.verify'
);

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

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// List loader
// =============================================================================

describe('GET /admin/apps/:appId/domains (list loader)', () => {
  it('returns domains for the given appId', async () => {
    mockListDomains.mockResolvedValue([MOCK_DOMAIN]);
    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0].name).toBe('example.com');
    expect(result.appId).toBe('app_test_1');
  });

  it('returns empty array when no domains', async () => {
    mockListDomains.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_test_1/domains');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsRoute.LoaderArgs);
    expect(result.domains).toHaveLength(0);
  });
});

// =============================================================================
// Create action
// =============================================================================

describe('POST /admin/apps/:appId/domains/new (create action)', () => {
  it('creates domain and redirects to detail page with ?created=1', async () => {
    mockCreateDomain.mockResolvedValue({ domain: { ...MOCK_DOMAIN, id: 'new_domain_id' }, dnsRecords: [] });

    const body = new URLSearchParams({ name: 'example.com' });
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await createAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsNewRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/app_test_1/domains/new_domain_id?created=1');
  });

  it('returns field errors for empty name', async () => {
    const body = new URLSearchParams({ name: '' });
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await createAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsNewRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
  });

  it('returns field error for invalid domain format', async () => {
    const body = new URLSearchParams({ name: 'not-a-domain' }); // no TLD
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await createAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsNewRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
  });

  it('returns field error for duplicate domain (unique constraint)', async () => {
    mockCreateDomain.mockRejectedValue(new Error('duplicate key value violates unique constraint "domains_name_idx"'));

    const body = new URLSearchParams({ name: 'example.com' });
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await createAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1' },
    } as unknown as DomainsNewRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
  });
});

// =============================================================================
// Detail loader
// =============================================================================

describe('GET /admin/apps/:appId/domains/:domainId (detail loader)', () => {
  it('returns domain by ID', async () => {
    mockGetDomain.mockResolvedValue(MOCK_DOMAIN);
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/domain_test_1');
    const result = await detailLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DomainDetailRoute.LoaderArgs);
    expect(result.domain.id).toBe('domain_test_1');
    expect(result.domain.name).toBe('example.com');
    expect(result.dmarcRua).toBe('dmarc@dmarc.example.com');
  });

  it('throws 404 for unknown domain ID', async () => {
    mockGetDomain.mockResolvedValue(null);
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/unknown');
    await expect(
      detailLoader({
        request: req,
        context: makeAdminContext(),
        params: { appId: 'app_test_1', domainId: 'unknown' },
      } as unknown as DomainDetailRoute.LoaderArgs),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Response && e.status === 404,
    );
  });
});

// =============================================================================
// Verify action
// =============================================================================

describe('POST /admin/apps/:appId/domains/:domainId/verify (verify action)', () => {
  it('enqueues verification and redirects with ?verified=1', async () => {
    mockGetDomain.mockResolvedValue(MOCK_DOMAIN);
    mockEnqueueVerification.mockResolvedValue(undefined);

    const req = new Request('http://localhost/admin/apps/app_test_1/domains/domain_test_1/verify', {
      method: 'POST',
    });
    const response = await verifyAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DomainVerifyRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/app_test_1/domains/domain_test_1?verified=1');
  });

  it('throws 404 when domain not found', async () => {
    mockGetDomain.mockResolvedValue(null);
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/unknown/verify', {
      method: 'POST',
    });
    await expect(
      verifyAction({
        request: req,
        context: makeAdminContext(),
        params: { appId: 'app_test_1', domainId: 'unknown' },
      } as unknown as DomainVerifyRoute.ActionArgs),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Response && e.status === 404,
    );
  });
});

describe('GET /admin/apps/:appId/domains/:domainId/verify (verify loader — GET redirect)', () => {
  it('redirects to detail page', async () => {
    const req = new Request('http://localhost/admin/apps/app_test_1/domains/domain_test_1/verify');
    const response = await verifyLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_test_1', domainId: 'domain_test_1' },
    } as unknown as DomainVerifyRoute.LoaderArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/app_test_1/domains/domain_test_1');
  });
});
