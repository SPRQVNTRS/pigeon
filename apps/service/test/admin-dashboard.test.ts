/**
 * Unit tests: Admin Dashboard loader
 *
 * Tests:
 * - loader: defaults to 7d range when no query param
 * - loader: respects 30d range from query param
 * - aggregate: bounceRate is null when emailsSent is 0
 * - aggregate: bounceRate computed correctly (bounceCount / emailsSent)
 * - aggregate: webhook failure count sums correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';

// ─── Mocks (must be before route imports) ─────────────────────────────────────

const mockListApps = vi.fn();
vi.mock('#app/models/apps.server', () => ({ listApps: mockListApps }));

const mockGetDashboardStats = vi.fn();
vi.mock('#app/models/dashboard.server', () => ({
  getDashboardStats: mockGetDashboardStats,
  parseRange: vi.fn((raw: string | null) => {
    if (raw === '30d' || raw === '90d') return raw;
    return '7d';
  }),
}));

// ─── Admin context ─────────────────────────────────────────────────────────────

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

// ─── Route import ──────────────────────────────────────────────────────────────

const { loader } = await import('../app/routes/admin.dashboard');

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const MOCK_APPS = [{ id: 'app1', name: 'App One', createdAt: new Date() }];

const EMPTY_STATS = {
  emailSentByApp: [],
  bounceByApp: [],
  failedWebhooks: [],
  recentEmails: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListApps.mockResolvedValue(MOCK_APPS);
  mockGetDashboardStats.mockResolvedValue(EMPTY_STATS);
});

function makeRequest(path: string) {
  return new Request(`http://localhost${path}`);
}

function makeLoaderArgs(req: Request) {
  return {
    request: req,
    context: makeAdminContext(),
    params: {},
  } as unknown as Parameters<typeof loader>[0];
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Admin Dashboard loader', () => {
  it('defaults to 7d range when no query param', async () => {
    await loader(makeLoaderArgs(makeRequest('/admin/dashboard')));
    expect(mockGetDashboardStats).toHaveBeenCalledWith('7d');
  });

  it('respects 30d range from query param', async () => {
    await loader(makeLoaderArgs(makeRequest('/admin/dashboard?range=30d')));
    expect(mockGetDashboardStats).toHaveBeenCalledWith('30d');
  });

  it('returns null bounceRate when emailsSent is 0', async () => {
    mockGetDashboardStats.mockResolvedValue({
      ...EMPTY_STATS,
      bounceByApp: [{ appId: 'app1', count: 5 }],
    });
    const result = await loader(makeLoaderArgs(makeRequest('/admin/dashboard')));
    expect(result.aggregate.bounceRate).toBeNull();
  });

  it('computes bounceRate correctly: 10 bounces / 100 sent = 0.1', async () => {
    mockGetDashboardStats.mockResolvedValue({
      ...EMPTY_STATS,
      emailSentByApp: [{ appId: 'app1', count: 100 }],
      bounceByApp: [{ appId: 'app1', count: 10 }],
    });
    const result = await loader(makeLoaderArgs(makeRequest('/admin/dashboard')));
    expect(result.aggregate.bounceRate).toBeCloseTo(0.1);
  });

  it('includes webhook failure count from failedWebhooks list', async () => {
    const now = new Date();
    mockGetDashboardStats.mockResolvedValue({
      ...EMPTY_STATS,
      failedWebhooks: [
        { id: 'wh1', appId: 'app1', url: 'https://example.com/hook1', lastFailureAt: now },
        { id: 'wh2', appId: 'app1', url: 'https://example.com/hook2', lastFailureAt: now },
      ],
    });
    const result = await loader(makeLoaderArgs(makeRequest('/admin/dashboard')));
    expect(result.aggregate.webhookFailureCount).toBe(2);
  });

  it('includes recentFailedWebhooks with appName resolved', async () => {
    const now = new Date();
    mockGetDashboardStats.mockResolvedValue({
      ...EMPTY_STATS,
      failedWebhooks: [
        { id: 'wh1', appId: 'app1', url: 'https://example.com/hook', lastFailureAt: now },
      ],
    });
    const result = await loader(makeLoaderArgs(makeRequest('/admin/dashboard')));
    expect(result.recentFailedWebhooks[0]?.appName).toBe('App One');
  });

  it('returns the range value in loader output', async () => {
    const result = await loader(makeLoaderArgs(makeRequest('/admin/dashboard?range=90d')));
    expect(result.range).toBe('90d');
  });
});
