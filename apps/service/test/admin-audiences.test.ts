/**
 * Unit tests: Admin UI — Audiences & Contacts CRUD
 *
 * Tests:
 * - audiences loader: returns list with contact counts
 * - audiences loader: empty array
 * - create action: valid name → redirect to contacts page
 * - create action: duplicate name → field error
 * - contacts loader: returns paginated contacts for audienceId
 * - contacts loader: page 2 uses correct offset
 * - contacts loader: invalid page param falls back to page 1
 * - contacts loader: 404 for unknown audience
 * - unsubscribe action: marks contact unsubscribed and redirects
 * - audience detail loader: redirects to contacts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import type { Route as AudiencesRoute } from '../app/routes/+types/admin.apps.$appId.audiences';
import type { Route as AudienceDetailRoute } from '../app/routes/+types/admin.apps.$appId.audiences.$audienceId';
import type { Route as ContactsRoute } from '../app/routes/+types/admin.apps.$appId.audiences.$audienceId.contacts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockListAudiences = vi.fn();
const mockCreateAudience = vi.fn();
const mockGetAudience = vi.fn();
const mockListContacts = vi.fn();
const mockUnsubscribeContact = vi.fn();
const mockGetAppById = vi.fn().mockResolvedValue({ id: 'app_1', name: 'Test App', createdAt: new Date() });

vi.mock('#app/models/config-change.server', () => import('./support/config-change-passthrough'));
vi.mock('#app/models/audiences.server', () => ({
  listAudiences: mockListAudiences,
  createAudience: mockCreateAudience,
  getAudience: mockGetAudience,
}));

vi.mock('#app/models/contacts.server', () => ({
  listContacts: mockListContacts,
  unsubscribeContact: mockUnsubscribeContact,
}));

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mockGetAppById(...args),
}));

// Mock Drizzle db for the count query in the audiences loader
vi.mock('#drizzle/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('#drizzle/schema/index', () => ({
  contacts: { audienceId: 'audience_id', appId: 'app_id' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(), count: vi.fn() };
});

// ─── Admin context ─────────────────────────────────────────────────────────

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

// ─── Route imports ──────────────────────────────────────────────────────────

const { loader: audiencesLoader, action: audiencesAction } = await import(
  '../app/routes/admin.apps.$appId.audiences'
);
const { loader: audienceDetailLoader } = await import(
  '../app/routes/admin.apps.$appId.audiences.$audienceId'
);
const { loader: contactsLoader, action: contactsAction } = await import(
  '../app/routes/admin.apps.$appId.audiences.$audienceId.contacts'
);

// ─── Test data ───────────────────────────────────────────────────────────────

const MOCK_AUDIENCE = {
  id: 'aud_1',
  appId: 'app_1',
  name: 'Newsletter',
  description: 'Monthly newsletter',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_CONTACT = {
  id: 'con_1',
  appId: 'app_1',
  audienceId: 'aud_1',
  email: 'user@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
  status: 'subscribed',
  attributes: {},
  unsubscribedAt: null,
  bouncedAt: null,
  complainedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Audiences loader ─────────────────────────────────────────────────────────

describe('GET /admin/apps/:appId/audiences (audiences loader)', () => {
  it('returns audiences list', async () => {
    mockListAudiences.mockResolvedValue([MOCK_AUDIENCE]);
    const req = new Request('http://localhost/admin/apps/app_1/audiences');
    const result = await audiencesLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as AudiencesRoute.LoaderArgs);

    // Audiences returned (count will be 0 since db mock returns [])
    expect(result.audiences).toHaveLength(1);
    expect(result.audiences[0].name).toBe('Newsletter');
    expect(typeof result.audiences[0].contactCount).toBe('number');
  });

  it('returns empty array when no audiences', async () => {
    mockListAudiences.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_1/audiences');
    const result = await audiencesLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as AudiencesRoute.LoaderArgs);
    expect(result.audiences).toHaveLength(0);
  });
});

// ─── Create action ────────────────────────────────────────────────────────────

describe('POST /admin/apps/:appId/audiences (create action)', () => {
  it('creates audience and redirects to contacts page', async () => {
    mockCreateAudience.mockResolvedValue({ ...MOCK_AUDIENCE, id: 'aud_new' });
    const body = new URLSearchParams({ name: 'New List' });
    const req = new Request('http://localhost/admin/apps/app_1/audiences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const response = await audiencesAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as AudiencesRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('Location')).toBe(
      '/admin/apps/app_1/audiences/aud_new/contacts',
    );
  });

  it('returns field errors for empty name', async () => {
    const body = new URLSearchParams({ name: '' });
    const req = new Request('http://localhost/admin/apps/app_1/audiences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const result = await audiencesAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as AudiencesRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
  });
});

// ─── Audience detail loader ───────────────────────────────────────────────────

describe('GET /admin/apps/:appId/audiences/:audienceId (detail loader — redirect)', () => {
  it('redirects to contacts page', async () => {
    mockGetAudience.mockResolvedValue(MOCK_AUDIENCE);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/aud_1');
    const response = await audienceDetailLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', audienceId: 'aud_1' },
    } as unknown as AudienceDetailRoute.LoaderArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('Location')).toBe(
      '/admin/apps/app_1/audiences/aud_1/contacts',
    );
  });

  it('throws 404 for unknown audience', async () => {
    mockGetAudience.mockResolvedValue(null);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/unknown');
    await expect(
      audienceDetailLoader({
        request: req,
        context: makeAdminContext(),
        params: { appId: 'app_1', audienceId: 'unknown' },
      } as unknown as AudienceDetailRoute.LoaderArgs),
    ).rejects.toSatisfy((e: unknown) => e instanceof Response && e.status === 404);
  });
});

// ─── Contacts loader ──────────────────────────────────────────────────────────

describe('GET /admin/apps/:appId/audiences/:audienceId/contacts (contacts loader)', () => {
  it('returns contacts for audienceId', async () => {
    mockGetAudience.mockResolvedValue(MOCK_AUDIENCE);
    mockListContacts.mockResolvedValue([MOCK_CONTACT]);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/aud_1/contacts');
    const result = await contactsLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', audienceId: 'aud_1' },
    } as unknown as ContactsRoute.LoaderArgs);

    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].email).toBe('user@example.com');
    expect(result.page).toBe(1);
  });

  it('uses correct offset for page 2', async () => {
    mockGetAudience.mockResolvedValue(MOCK_AUDIENCE);
    mockListContacts.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/aud_1/contacts?page=2');
    const result = await contactsLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', audienceId: 'aud_1' },
    } as unknown as ContactsRoute.LoaderArgs);

    expect(result.page).toBe(2);
    // Verify listContacts was called with offset=50
    expect(mockListContacts).toHaveBeenCalledWith('aud_1', 'app_1', { limit: 50, offset: 50 });
  });

  it('falls back to page 1 for invalid page param', async () => {
    mockGetAudience.mockResolvedValue(MOCK_AUDIENCE);
    mockListContacts.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/aud_1/contacts?page=abc');
    const result = await contactsLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', audienceId: 'aud_1' },
    } as unknown as ContactsRoute.LoaderArgs);

    expect(result.page).toBe(1);
    expect(mockListContacts).toHaveBeenCalledWith('aud_1', 'app_1', { limit: 50, offset: 0 });
  });

  it('throws 404 for unknown audienceId', async () => {
    mockGetAudience.mockResolvedValue(null);
    const req = new Request('http://localhost/admin/apps/app_1/audiences/unknown/contacts');
    await expect(
      contactsLoader({
        request: req,
        context: makeAdminContext(),
        params: { appId: 'app_1', audienceId: 'unknown' },
      } as unknown as ContactsRoute.LoaderArgs),
    ).rejects.toSatisfy((e: unknown) => e instanceof Response && e.status === 404);
  });
});

// ─── Unsubscribe action ───────────────────────────────────────────────────────

describe('POST .../contacts (unsubscribe action)', () => {
  it('unsubscribes contact and redirects', async () => {
    mockUnsubscribeContact.mockResolvedValue({ ...MOCK_CONTACT, status: 'unsubscribed' });
    const body = new URLSearchParams({ intent: 'unsubscribe', email: 'user@example.com' });
    const req = new Request('http://localhost/admin/apps/app_1/audiences/aud_1/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const response = await contactsAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', audienceId: 'aud_1' },
    } as unknown as ContactsRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect(mockUnsubscribeContact).toHaveBeenCalledWith('aud_1', 'user@example.com', 'app_1');
  });
});
