/**
 * Unit tests: the webhook admin API sits behind adminAuthMiddleware
 *
 * 1. routes.ts registers both routes inside the `_admin_api` layout.
 * 2. That layout runs adminAuthMiddleware.
 * 3. adminAuthMiddleware rejects missing or wrong Bearer tokens before next().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import routes from '../app/routes';
import { middleware as adminApiLayoutMiddleware } from '../app/routes/_admin-api';
import { adminAuthMiddleware } from '#app/middleware/admin-auth';

function findLayout(entries: readonly RouteConfigEntry[], id: string): RouteConfigEntry | undefined {
  for (const entry of entries) {
    if (entry.id === id) return entry;
    const nested = entry.children ? findLayout(entry.children, id) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

function flatten(entries: readonly RouteConfigEntry[]): RouteConfigEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
}

describe('webhook admin API routes are guarded by the admin layout', () => {
  const layout = findLayout(routes as RouteConfigEntry[], '_admin_api');

  it('registers the list/create route inside the _admin_api layout', () => {
    const children = flatten(layout?.children ?? []);
    const entry = children.find((e) => e.path === '/v1/admin/apps/:id/webhooks');
    expect(entry?.file).toBe('routes/api.v1.admin.apps.$id.webhooks.tsx');
  });

  it('registers the rotate route inside the _admin_api layout', () => {
    const children = flatten(layout?.children ?? []);
    const entry = children.find((e) => e.path === '/v1/admin/apps/:id/webhooks/:webhookId/rotate');
    expect(entry?.file).toBe('routes/api.v1.admin.apps.$id.webhooks.$webhookId.rotate.tsx');
  });

  it('does not register either route outside the layout', () => {
    const outside = flatten((routes as RouteConfigEntry[]).filter((e) => e.id !== '_admin_api'));
    expect(outside.some((e) => e.path?.includes('/webhooks') && e.path.startsWith('/v1/admin'))).toBe(false);
  });

  it('runs adminAuthMiddleware as the layout middleware', () => {
    expect(layout?.file).toBe('routes/_admin-api.tsx');
    expect(adminApiLayoutMiddleware).toContain(adminAuthMiddleware);
  });
});

describe('adminAuthMiddleware', () => {
  const originalSecret = process.env.ADMIN_SECRET;

  beforeEach(() => {
    process.env.ADMIN_SECRET = 'test-admin-secret';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = originalSecret;
  });

  async function run(authorization: string | null) {
    const next = vi.fn().mockResolvedValue(new Response('ok'));
    const context = { set: vi.fn() };
    const headers = authorization ? { authorization } : undefined;
    const request = new Request('http://localhost/v1/admin/apps/app_1/webhooks', { headers });
    const response = await adminAuthMiddleware({ request, context, params: {} } as never, next);
    return { response: response as Response, next };
  }

  it('answers 401 and never calls next() without a token', async () => {
    const { response, next } = await run(null);
    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a wrong token', async () => {
    const { response, next } = await run('Bearer wrong-secret');
    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 401 for a non-Bearer scheme', async () => {
    const { response, next } = await run('Basic dGVzdC1hZG1pbi1zZWNyZXQ=');
    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 when ADMIN_SECRET is not configured', async () => {
    delete process.env.ADMIN_SECRET;
    const { response, next } = await run('Bearer anything');
    expect(response.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for the right token', async () => {
    const { response, next } = await run('Bearer test-admin-secret');
    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
