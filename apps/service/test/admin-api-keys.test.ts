/**
 * Unit tests: Admin UI — API Keys CRUD loaders and actions
 *
 * Tests:
 * - list loader: returns active keys for appId
 * - list loader: returns revoked keys for appId
 * - list loader: reads and consumes newApiKey flash from session
 * - list loader: reads and consumes revokedKey flash from session
 * - list loader: empty array
 * - create action: valid name → redirect to keys list
 * - create action: stores plaintext key in session flash
 * - create action: invalid name → field errors
 * - revoke action: revokes key and redirects with revokedKey flash
 * - revoke action loader GET: redirects to keys list
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { userContext } from '#app/middleware/context';
import type { Route as KeysRoute } from '../app/routes/+types/admin.apps.$appId.keys';
import type { Route as RevokeRoute } from '../app/routes/+types/admin.apps.$appId.keys.$keyId.revoke';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockListApiKeys = vi.fn();
const mockCreateApiKey = vi.fn();
const mockRevokeApiKey = vi.fn();

vi.mock('#app/models/api-keys.server', () => ({
  listApiKeys: mockListApiKeys,
  createApiKey: mockCreateApiKey,
  revokeApiKey: mockRevokeApiKey,
}));

const mockGetAppById = vi.fn().mockResolvedValue({ id: 'app_1', name: 'Test App', createdAt: new Date() });

vi.mock('#app/models/apps.server', () => ({
  getAppById: (...args: unknown[]) => mockGetAppById(...args),
}));

// Session mock — per-test session store
const mockSessionData: Record<string, unknown> = {};
const mockSession = {
  get: (key: string) => mockSessionData[key],
  set: (key: string, value: unknown) => { mockSessionData[key] = value; },
  unset: (key: string) => { delete mockSessionData[key]; },
};
const mockCommitSession = vi.fn().mockResolvedValue('session-cookie=value');
const mockGetSession = vi.fn().mockResolvedValue(mockSession);

vi.mock('#app/services/session.server', () => ({
  sessionStorage: {
    getSession: (...args: unknown[]) => mockGetSession(...args),
    commitSession: (...args: unknown[]) => mockCommitSession(...args),
  },
}));

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

const { loader: keysLoader, action: keysAction } = await import(
  '../app/routes/admin.apps.$appId.keys'
);
const { loader: revokeLoader, action: revokeAction } = await import(
  '../app/routes/admin.apps.$appId.keys.$keyId.revoke'
);

// ─── Test data ───────────────────────────────────────────────────────────────

const ACTIVE_KEY = {
  id: 'key_active_1',
  appId: 'app_1',
  name: 'Production',
  prefix: 'ske_abcd',
  hashedKey: 'hash123',
  createdAt: new Date(),
  updatedAt: new Date(),
  revokedAt: null,
  lastUsedAt: null,
};

const REVOKED_KEY = {
  ...ACTIVE_KEY,
  id: 'key_revoked_1',
  name: 'Old Key',
  revokedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset session data
  Object.keys(mockSessionData).forEach((k) => delete mockSessionData[k]);
  mockGetSession.mockResolvedValue(mockSession);
  mockCommitSession.mockResolvedValue('session-cookie=value');
});

// ─── List loader ─────────────────────────────────────────────────────────────

describe('GET /admin/apps/:appId/keys (list loader)', () => {
  it('returns active keys for appId', async () => {
    mockListApiKeys.mockResolvedValue([ACTIVE_KEY]);
    const req = new Request('http://localhost/admin/apps/app_1/keys');
    const response = await keysLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.LoaderArgs);

    const data = await (response as Response).json() as { keys: typeof ACTIVE_KEY[] };
    expect(data.keys).toHaveLength(1);
    expect(data.keys[0].name).toBe('Production');
    expect(data.keys[0].revokedAt).toBeNull();
  });

  it('returns revoked keys for appId (still shown in list)', async () => {
    mockListApiKeys.mockResolvedValue([ACTIVE_KEY, REVOKED_KEY]);
    const req = new Request('http://localhost/admin/apps/app_1/keys');
    const response = await keysLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.LoaderArgs);

    const data = await (response as Response).json() as { keys: typeof ACTIVE_KEY[] };
    expect(data.keys).toHaveLength(2);
    expect(data.keys[1].revokedAt).toBeTruthy();
  });

  it('returns empty array when no keys', async () => {
    mockListApiKeys.mockResolvedValue([]);
    const req = new Request('http://localhost/admin/apps/app_1/keys');
    const response = await keysLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.LoaderArgs);

    const data = await (response as Response).json() as { keys: unknown[] };
    expect(data.keys).toHaveLength(0);
  });

  it('reads and consumes newApiKey flash from session', async () => {
    mockListApiKeys.mockResolvedValue([]);
    mockSessionData['newApiKey'] = 'ske_plaintextkeyvalue';

    const req = new Request('http://localhost/admin/apps/app_1/keys');
    const response = await keysLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.LoaderArgs);

    const data = await (response as Response).json() as { newApiKey: string | null };
    // Flash is returned to UI
    expect(data.newApiKey).toBe('ske_plaintextkeyvalue');
    // Flash is consumed (unset from session)
    expect(mockSessionData['newApiKey']).toBeUndefined();
    // Session is committed so Set-Cookie header persists the consumption
    expect(mockCommitSession).toHaveBeenCalled();
  });

  it('reads and consumes revokedKey flash from session', async () => {
    mockListApiKeys.mockResolvedValue([]);
    mockSessionData['revokedKey'] = true;

    const req = new Request('http://localhost/admin/apps/app_1/keys');
    const response = await keysLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.LoaderArgs);

    const data = await (response as Response).json() as { revokedFlash: boolean };
    expect(data.revokedFlash).toBe(true);
    expect(mockSessionData['revokedKey']).toBeUndefined();
    expect(mockCommitSession).toHaveBeenCalled();
  });
});

// ─── Create action ───────────────────────────────────────────────────────────

describe('POST /admin/apps/:appId/keys (create action)', () => {
  it('creates key and redirects to keys list', async () => {
    mockCreateApiKey.mockResolvedValue({
      plaintext: 'ske_newkeyplaintext',
      record: { ...ACTIVE_KEY, id: 'key_new_1' },
    });

    const body = new URLSearchParams({ name: 'New Key' });
    const req = new Request('http://localhost/admin/apps/app_1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const response = await keysAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/app_1/keys');
  });

  it('stores plaintext key in session flash', async () => {
    const plaintext = 'ske_newkeyplaintext';
    mockCreateApiKey.mockResolvedValue({
      plaintext,
      record: { ...ACTIVE_KEY, id: 'key_new_1' },
    });

    const body = new URLSearchParams({ name: 'New Key' });
    const req = new Request('http://localhost/admin/apps/app_1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    await keysAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.ActionArgs);

    // Flash key was set in session
    expect(mockSessionData['newApiKey']).toBe(plaintext);
    // Session was committed
    expect(mockCommitSession).toHaveBeenCalled();
  });

  it('returns field errors for empty name', async () => {
    const body = new URLSearchParams({ name: '' });
    const req = new Request('http://localhost/admin/apps/app_1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const result = await keysAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1' },
    } as unknown as KeysRoute.ActionArgs);

    expect(result).not.toBeInstanceOf(Response);
    expect((result as { status: string }).status).toBe('error');
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
});

// ─── Revoke action ────────────────────────────────────────────────────────────

describe('POST /admin/apps/:appId/keys/:keyId/revoke (revoke action)', () => {
  it('revokes key and redirects with revokedKey flash', async () => {
    mockRevokeApiKey.mockResolvedValue({ ...ACTIVE_KEY, revokedAt: new Date() });

    const req = new Request('http://localhost/admin/apps/app_1/keys/key_active_1/revoke', {
      method: 'POST',
    });

    const response = await revokeAction({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', keyId: 'key_active_1' },
    } as unknown as RevokeRoute.ActionArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    const location = (response as Response).headers.get('Location');
    expect(location).toBe('/admin/apps/app_1/keys');
    // revokedKey flash was set
    expect(mockSessionData['revokedKey']).toBe(true);
    expect(mockCommitSession).toHaveBeenCalled();
  });
});

describe('GET /admin/apps/:appId/keys/:keyId/revoke (revoke loader)', () => {
  it('redirects to keys list on GET', async () => {
    const req = new Request('http://localhost/admin/apps/app_1/keys/key_active_1/revoke');
    const response = await revokeLoader({
      request: req,
      context: makeAdminContext(),
      params: { appId: 'app_1', keyId: 'key_active_1' },
    } as unknown as RevokeRoute.LoaderArgs);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get('Location')).toBe('/admin/apps/app_1/keys');
  });
});
