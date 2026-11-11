/**
 * Bearer admin API: read-only lists of an app's domains and audiences
 *
 * GET /v1/admin/apps/:id/domains
 * GET /v1/admin/apps/:id/audiences
 *
 * Real throwaway Postgres, see test/support/test-database.ts (local:
 * DB_PORT=5433 pnpm test). A mocked query cannot show that the WHERE clause
 * keeps one app's rows away from another app. The admin layout guard is
 * covered at the bottom of this file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import { audiences, domains } from '#drizzle/schema/index';
import type { Database } from '#app/lib/db-types';
import routes from '../app/routes';
import { middleware as adminApiLayoutMiddleware } from '../app/routes/_admin-api';
import { adminAuthMiddleware } from '#app/middleware/admin-auth';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { seedApp } from './support/seed';

const holder = vi.hoisted(() => ({ db: undefined as Database | undefined }));

vi.mock('#drizzle/db', () => ({
  get db() {
    return holder.db;
  },
}));

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

const domainsRoute = await import('../app/routes/api.v1.admin.apps.$id.domains');
const audiencesRoute = await import('../app/routes/api.v1.admin.apps.$id.audiences');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

let testDb: TestDatabase;
let appA: string;
let appB: string;

const VERIFIED_AT = new Date('2026-11-05T12:00:00Z');

beforeAll(async () => {
  testDb = await createTestDatabase();
  holder.db = testDb.db;
  appA = await seedApp({ db: testDb.db });
  appB = await seedApp({ db: testDb.db });

  await testDb.db.insert(domains).values([
    {
      appId: appA,
      name: 'mail.alpha.example.test',
      dkimSelector: 'pigeon',
      dkimTokens: ['tok1', 'tok2', 'tok3'],
      dkimStatus: 'verified',
      spfStatus: 'verified',
      verifiedAt: VERIFIED_AT,
    },
    { appId: appB, name: 'mail.beta.example.test' },
  ]);
  await testDb.db.insert(audiences).values([
    { appId: appA, name: 'Alpha newsletter', description: 'Weekly' },
    { appId: appB, name: 'Beta newsletter' },
  ]);
}, 60_000);

afterAll(async () => {
  await testDb?.drop();
}, 30_000);

function get(path: string, appId: string): { request: Request; params: { id: string } } {
  return { request: new Request(`http://localhost${path}`), params: { id: appId } };
}

async function readJson(response: unknown): Promise<any> {
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).headers.get('Cache-Control')).toBe('no-store');
  return (response as Response).json();
}

describe('GET /v1/admin/apps/:id/domains', () => {
  it('lists only the domains of the given app, with the fields of GET /v1/domains', async () => {
    const response = await domainsRoute.loader(get(`/v1/admin/apps/${appA}/domains`, appA) as AnyArgs);
    expect((response as Response).status).toBe(200);

    const body = await readJson(response);
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0]).toEqual({
      id: expect.any(String),
      appId: appA,
      name: 'mail.alpha.example.test',
      region: 'eu-central-1',
      dkimSelector: 'pigeon',
      dkimTokens: ['tok1', 'tok2', 'tok3'],
      spfStatus: 'verified',
      dkimStatus: 'verified',
      dmarcStatus: 'pending',
      mxStatus: 'pending',
      verifiedAt: VERIFIED_AT.toISOString(),
      lastVerificationError: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('does not show app A rows to app B', async () => {
    const body = await readJson(await domainsRoute.loader(get(`/v1/admin/apps/${appB}/domains`, appB) as AnyArgs));
    expect(body.domains.map((d: { name: string }) => d.name)).toEqual(['mail.beta.example.test']);
  });

  it('answers 200 with an empty list for an app with no domains', async () => {
    const emptyApp = await seedApp({ db: testDb.db });
    const body = await readJson(await domainsRoute.loader(get(`/v1/admin/apps/${emptyApp}/domains`, emptyApp) as AnyArgs));
    expect(body).toEqual({ domains: [] });
  });

  it('answers 404 app_not_found for an unknown app', async () => {
    const response = (await domainsRoute.loader(get('/v1/admin/apps/nope/domains', 'nope') as AnyArgs)) as Response;
    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe('app_not_found');
  });

  it('answers 405 with Allow: GET for any other method', async () => {
    const response = (await domainsRoute.action()) as Response;
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect((await readJson(response)).error.code).toBe('method_not_allowed');
  });
});

describe('GET /v1/admin/apps/:id/audiences', () => {
  it('lists only the audiences of the given app, with the fields of GET /v1/audiences', async () => {
    const response = await audiencesRoute.loader(get(`/v1/admin/apps/${appA}/audiences`, appA) as AnyArgs);
    expect((response as Response).status).toBe(200);

    const body = await readJson(response);
    expect(body.audiences).toHaveLength(1);
    expect(body.audiences[0]).toEqual({
      id: expect.any(String),
      appId: appA,
      name: 'Alpha newsletter',
      description: 'Weekly',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('does not show app A rows to app B', async () => {
    const body = await readJson(await audiencesRoute.loader(get(`/v1/admin/apps/${appB}/audiences`, appB) as AnyArgs));
    expect(body.audiences.map((a: { name: string }) => a.name)).toEqual(['Beta newsletter']);
    expect(body.audiences[0].description).toBeNull();
  });

  it('answers 404 app_not_found for an unknown app', async () => {
    const response = (await audiencesRoute.loader(get('/v1/admin/apps/nope/audiences', 'nope') as AnyArgs)) as Response;
    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe('app_not_found');
  });

  it('answers 405 with Allow: GET for any other method', async () => {
    const response = (await audiencesRoute.action()) as Response;
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
});

// ─── Auth: the routes sit behind the admin layout ───────────────────────────

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

describe('the list routes are guarded by the admin layout', () => {
  const layout = findLayout(routes as RouteConfigEntry[], '_admin_api');
  const inside = flatten(layout?.children ?? []);

  it.each([
    ['/v1/admin/apps/:id/domains', 'routes/api.v1.admin.apps.$id.domains.tsx'],
    ['/v1/admin/apps/:id/audiences', 'routes/api.v1.admin.apps.$id.audiences.tsx'],
  ])('registers %s inside the _admin_api layout', (path, file) => {
    expect(inside.find((entry) => entry.path === path)?.file).toBe(file);
  });

  it('registers neither route outside the layout', () => {
    const outside = flatten((routes as RouteConfigEntry[]).filter((entry) => entry.id !== '_admin_api'));
    const paths = outside.map((entry) => entry.path ?? '');
    expect(paths).not.toContain('/v1/admin/apps/:id/domains');
    expect(paths).not.toContain('/v1/admin/apps/:id/audiences');
  });

  it('runs adminAuthMiddleware as the layout middleware, which answers 401 without a token', async () => {
    expect(adminApiLayoutMiddleware).toContain(adminAuthMiddleware);

    process.env.ADMIN_SECRET = 'test-admin-secret';
    const next = vi.fn().mockResolvedValue(new Response('ok'));
    const request = new Request('http://localhost/v1/admin/apps/app_1/domains');
    const response = (await adminAuthMiddleware({ request, context: { set: vi.fn() }, params: {} } as never, next)) as Response;
    expect(response.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
