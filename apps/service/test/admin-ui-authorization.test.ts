/**
 * Guard: every loader and action under the admin UI layout needs the admin role.
 *
 * React Router runs child loaders in parallel with the layout loader, a
 * `.data` request with `?_routes=` runs only the loaders it names, and an
 * action runs with no loader before it. So a role check in the layout loader
 * alone does not protect a child route. The check must run in the layout
 * middleware, which runs for every request that matches the layout.
 *
 * This file walks every route under the `_admin_ui` layout in app/routes.ts.
 * Each child's real module decides whether it has a loader or an action; that
 * export is then replaced with a spy, so no business logic runs. Requests go
 * through the real React Router request handler (test/support/api-server.ts)
 * with the real layout module and the real session cookie. The guard is the
 * request, not the path: whatever path a future route uses, it is in this list
 * as soon as it sits under the layout.
 *
 * - anonymous and a signed-in non-admin: no spy runs, for a document GET, a
 *   `.data` GET that names only the child, a document POST and a `.data` POST.
 * - an admin: every spy runs. Without this half the test would pass for a
 *   route the requests never reach.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import routeConfig from '../app/routes';
import { createApiHandler } from './support/api-server';

const holder = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}));

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'error';
});

// authMiddleware reads the signed-in user back from the database.
vi.mock('#drizzle/db', () => ({
  db: {
    query: {
      users: {
        findFirst: async () => holder.user,
      },
    },
  },
}));

const { sessionStorage } = await import('#app/services/session.server');
const adminUiLayout = await import('../app/routes/_admin-ui');
const { authMiddleware } = await import('#app/middleware/auth');
const { adminRoleMiddleware } = await import('#app/middleware/admin-role');

const LAYOUT_ID = '_admin_ui';
const LAYOUT_FILE = 'routes/_admin-ui.tsx';

type Role = 'admin' | 'manager' | 'editor';

function userWithRole(role: Role): Record<string, unknown> {
  return {
    id: 7,
    email: `${role}@example.com`,
    name: role,
    role,
    password: 'hashed',
    deactivated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function findLayout(entries: readonly RouteConfigEntry[]): RouteConfigEntry {
  const layout = entries.find((entry) => entry.id === LAYOUT_ID);
  if (!layout) throw new Error(`app/routes.ts has no ${LAYOUT_ID} layout`);
  return layout;
}

function flatten(entries: readonly RouteConfigEntry[]): RouteConfigEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
}

function routeIdFor(entry: RouteConfigEntry): string {
  return entry.id ?? entry.file.replace(/\.[^./]+$/, '');
}

/** A concrete URL for a route path: every `:param` becomes a fixed value. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'x1');
}

interface GuardedRoute {
  id: string;
  file: string;
  path: string;
  loader: ReturnType<typeof vi.fn> | null;
  action: ReturnType<typeof vi.fn> | null;
}

const layoutEntry = findLayout(routeConfig as RouteConfigEntry[]);
const childEntries = flatten(layoutEntry.children ?? []);
const guarded: GuardedRoute[] = [];
const modules: Record<string, unknown> = { [LAYOUT_FILE]: adminUiLayout };

for (const entry of childEntries) {
  if (entry.path === undefined) throw new Error(`${entry.file} under ${LAYOUT_ID} has no path`);
  const real = (await import(/* @vite-ignore */ `../app/${entry.file}`)) as Record<string, unknown>;
  const loader = typeof real.loader === 'function' ? vi.fn(async () => null) : null;
  const action = typeof real.action === 'function' ? vi.fn(async () => null) : null;
  modules[entry.file] = {
    ...real,
    ...(loader ? { loader } : {}),
    ...(action ? { action } : {}),
  };
  guarded.push({ id: routeIdFor(entry), file: entry.file, path: entry.path, loader, action });
}

const handle = createApiHandler({ modules });

async function sessionCookie(): Promise<string> {
  const session = await sessionStorage.getSession();
  session.set('user', { id: 7 });
  const setCookie = await sessionStorage.commitSession(session);
  return setCookie.split(';')[0] ?? '';
}

interface Probe {
  label: string;
  request: (opts: { route: GuardedRoute; cookie: string | null }) => Request;
  spy: (route: GuardedRoute) => ReturnType<typeof vi.fn> | null;
}

function headersFor(cookie: string | null): Record<string, string> {
  return cookie ? { cookie } : {};
}

function formPost(opts: { url: string; cookie: string | null }): Request {
  return new Request(opts.url, {
    method: 'POST',
    headers: { ...headersFor(opts.cookie), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=probe',
  });
}

const PROBES: Probe[] = [
  {
    label: 'document GET',
    spy: (route) => route.loader,
    request: ({ route, cookie }) =>
      new Request(`http://localhost${concretePath(route.path)}`, { headers: headersFor(cookie) }),
  },
  {
    label: '.data GET that names only the child loader',
    spy: (route) => route.loader,
    request: ({ route, cookie }) =>
      new Request(`http://localhost${concretePath(route.path)}.data?_routes=${encodeURIComponent(route.id)}`, {
        headers: headersFor(cookie),
      }),
  },
  {
    label: 'document POST',
    spy: (route) => route.action,
    request: ({ route, cookie }) => formPost({ url: `http://localhost${concretePath(route.path)}`, cookie }),
  },
  {
    label: '.data POST',
    spy: (route) => route.action,
    request: ({ route, cookie }) => formPost({ url: `http://localhost${concretePath(route.path)}.data`, cookie }),
  },
];

const CASES = guarded.flatMap((route) =>
  PROBES.filter((probe) => probe.spy(route) !== null).map((probe) => ({
    name: `${route.file}: ${probe.label}`,
    route,
    probe,
  })),
);

let cookie = '';

beforeAll(async () => {
  cookie = await sessionCookie();
});

afterEach(() => {
  holder.user = null;
  vi.clearAllMocks();
});

describe('the admin UI layout', () => {
  it('covers a non-empty set of loaders and actions', () => {
    expect(guarded.length).toBeGreaterThan(10);
    expect(CASES.length).toBeGreaterThan(guarded.length);
  });

  it('runs the role check as middleware right after the session check', () => {
    expect(adminUiLayout.middleware).toEqual([authMiddleware, adminRoleMiddleware]);
  });
});

describe.each(CASES)('$name', ({ route, probe }) => {
  it('never runs for an anonymous request', async () => {
    const response = await handle(probe.request({ route, cookie: null }));
    expect(probe.spy(route)).not.toHaveBeenCalled();
    expect(response.status).not.toBe(200);
  });

  it.each<Role>(['editor', 'manager'])('never runs for a signed-in %s', async (role) => {
    holder.user = userWithRole(role);
    const response = await handle(probe.request({ route, cookie }));
    expect(probe.spy(route)).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it('runs for an admin, so the probe really reaches the route', async () => {
    holder.user = userWithRole('admin');
    await handle(probe.request({ route, cookie }));
    expect(probe.spy(route)).toHaveBeenCalled();
  });
});
