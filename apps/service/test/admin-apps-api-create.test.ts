/**
 * POST /v1/admin/apps answers 409 { error: 'app_name_taken' } when the name is
 * taken (createApp throws AppNameTakenError, see app-name-unique-db.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppNameTakenError } from '#app/lib/app-name-taken';

const mockCreateApp = vi.hoisted(() => vi.fn());

vi.mock('#app/models/apps.server', () => ({
  createApp: (...args: unknown[]) => mockCreateApp(...args),
  listApps: vi.fn(),
}));

vi.mock('#app/lib/logger', () => ({
  createComponentLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { action } = await import('../app/routes/api.v1.admin.apps');

function post(name: string): Parameters<typeof action>[0] {
  return {
    request: new Request('http://localhost/v1/admin/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  } as unknown as Parameters<typeof action>[0];
}

beforeEach(() => {
  mockCreateApp.mockReset();
});

describe('POST /v1/admin/apps', () => {
  it('answers 409 app_name_taken when another app has the name', async () => {
    mockCreateApp.mockRejectedValue(new AppNameTakenError('taken-app'));
    const response = await action(post('taken-app'));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'app_name_taken' });
  });

  it('answers 201 with the app for a free name', async () => {
    mockCreateApp.mockResolvedValue({ id: 'app_new', name: 'free-app', stateVersion: 0, createdAt: new Date() });
    const response = await action(post('free-app'));
    expect(response.status).toBe(201);
    expect((await response.json()).app.name).toBe('free-app');
  });

  it('still answers 500 for any other error', async () => {
    mockCreateApp.mockRejectedValue(new Error('db down'));
    const response = await action(post('any-app'));
    expect(response.status).toBe(500);
  });
});
