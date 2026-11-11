/**
 * Unit tests: Admin UI — Apps CRUD loaders and actions
 *
 * Tests:
 * - list loader: returns all apps
 * - create action: valid input → redirect to /admin/apps/:id?created=1
 * - create action: invalid input → returns field errors
 * - detail loader: returns app by ID
 * - detail loader: throws 404 for unknown ID
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import { AppNameTakenError } from '#app/lib/app-name-taken';
import type { Route as AppsRoute } from '../app/routes/+types/admin.apps';
import type { Route as AppsNewRoute } from '../app/routes/+types/admin.apps.new';
import type { Route as AppsIdRoute } from '../app/routes/+types/admin.apps.$id';

// Mock apps model before importing routes
const mockListApps = vi.fn();
const mockCreateApp = vi.fn();
const mockGetAppById = vi.fn();

vi.mock('#app/models/apps.server', () => ({
  listApps: mockListApps,
  createApp: mockCreateApp,
  getAppById: mockGetAppById,
}));

const mockCountApiKeys = vi.fn().mockResolvedValue(0);
const mockCountAudiences = vi.fn().mockResolvedValue(0);
const mockCountWebhooks = vi.fn().mockResolvedValue(0);
const mockCountDomains = vi.fn().mockResolvedValue(0);

vi.mock('#app/models/api-keys.server', () => ({
  countApiKeys: (...args: unknown[]) => mockCountApiKeys(...args),
}));

vi.mock('#app/models/audiences.server', () => ({
  countAudiences: (...args: unknown[]) => mockCountAudiences(...args),
}));

vi.mock('#app/models/webhooks.server', () => ({
  countWebhooks: (...args: unknown[]) => mockCountWebhooks(...args),
}));

vi.mock('#app/models/domains.server', () => ({
  countDomains: (...args: unknown[]) => mockCountDomains(...args),
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

const { loader: listLoader } = await import('../app/routes/admin.apps');
const { loader: newLoader, action: createAction } = await import('../app/routes/admin.apps.new');
const { loader: detailLoader } = await import('../app/routes/admin.apps.$id');

const MOCK_APP = {
  id: 'cltest12345',
  name: 'Test App',
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /admin/apps (list loader)', () => {
  it('returns all apps', async () => {
    mockListApps.mockResolvedValue([MOCK_APP]);
    const req = new Request('http://localhost/admin/apps');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsRoute.LoaderArgs);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].id).toBe('cltest12345');
  });

  it('returns empty array when no apps', async () => {
    mockListApps.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps');
    const result = await listLoader({
      request: req,
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsRoute.LoaderArgs);
    expect(result.apps).toHaveLength(0);
  });
});

describe('GET /admin/apps/new (new loader)', () => {
  it('returns user from context', async () => {
    const req = new Request('http://localhost/admin/apps/new');
    const result = await newLoader({
      request: req,
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsNewRoute.LoaderArgs);
    expect(result.user.email).toBe('admin@example.com');
  });
});

describe('POST /admin/apps/new (create action)', () => {
  it('creates app and redirects to detail page with ?created=1', async () => {
    mockCreateApp.mockResolvedValue({ ...MOCK_APP, id: 'newappid1' });

    const body = new URLSearchParams({ name: 'My App' });
    const req = new Request('http://localhost/admin/apps/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await createAction({
      request: req,
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsNewRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/newappid1?created=1');
  });

  it('returns field errors for empty name', async () => {
    const body = new URLSearchParams({ name: '' });
    const req = new Request('http://localhost/admin/apps/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await createAction({
      request: req,
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsNewRoute.ActionArgs);

    // Should not be a redirect
    expect(result).not.toBeInstanceOf(Response);
    // Should have error state
    expect((result as { status: string }).status).toBe('error');
  });
});

describe('POST /admin/apps/new when the name is taken', () => {
  it('shows a field error on the name and does not redirect', async () => {
    mockCreateApp.mockRejectedValue(new AppNameTakenError('Test App'));
    const result = await createAction({
      request: new Request('http://localhost/admin/apps/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: 'Test App' }).toString(),
      }),
      context: makeAdminContext(),
      params: {},
    } as unknown as AppsNewRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { error?: Record<string, string[]> }).error?.name).toEqual(['An app with this name already exists']);
  });

  it('still throws any other error', async () => {
    mockCreateApp.mockRejectedValue(new Error('db down'));
    await expect(
      createAction({
        request: new Request('http://localhost/admin/apps/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ name: 'Test App' }).toString(),
        }),
        context: makeAdminContext(),
        params: {},
      } as unknown as AppsNewRoute.ActionArgs),
    ).rejects.toThrow('db down');
  });
});

describe('GET /admin/apps/:id (detail loader)', () => {
  it('returns app by ID', async () => {
    mockGetAppById.mockResolvedValue(MOCK_APP);
    const req = new Request('http://localhost/admin/apps/cltest12345');
    const result = await detailLoader({
      request: req,
      context: makeAdminContext(),
      params: { id: 'cltest12345' },
    } as unknown as AppsIdRoute.LoaderArgs);
    expect(result.app.id).toBe('cltest12345');
    expect(result.app.name).toBe('Test App');
  });

  it('throws 404 for unknown app ID', async () => {
    mockGetAppById.mockResolvedValue(null);
    const req = new Request('http://localhost/admin/apps/unknown');
    await expect(
      detailLoader({
        request: req,
        context: makeAdminContext(),
        params: { id: 'unknown' },
      } as unknown as AppsIdRoute.LoaderArgs),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Response && e.status === 404,
    );
  });
});
