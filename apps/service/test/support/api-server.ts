/**
 * The real React Router request handler, in process, for the real route table.
 *
 * A test that calls a route's `action` directly skips three things a caller
 * meets: the path match, the `_api` layout middleware that checks the API key,
 * and the 404 for a path nobody serves. This helper builds a ServerBuild from
 * app/routes.ts itself (same paths, same layouts, same ids the framework
 * derives) and hands it to createRequestHandler, so a request goes through the
 * same match, middleware and action chain as in production.
 *
 * Only the route modules the caller passes in are loaded, because importing
 * every route would pull in the whole service. Any other route in the table
 * gets an empty module, so a request that matches one of them answers 405 and
 * not what the real route would. Tests that need a "no route" answer must use a
 * path that matches nothing in app/routes.ts.
 */
import { createRequestHandler, type ServerBuild } from 'react-router';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import routeConfig from '../../app/routes';

type ServerRouteManifest = ServerBuild['routes'];
type ServerRouteModule = NonNullable<ServerRouteManifest[string]>['module'];

const ROOT_ID = 'root';

function routeIdFor(entry: RouteConfigEntry): string {
  return entry.id ?? entry.file.replace(/\.[^./]+$/, '');
}

function addEntries(opts: {
  entries: readonly RouteConfigEntry[];
  parentId: string;
  modules: Readonly<Record<string, unknown>>;
  manifest: ServerRouteManifest;
}): void {
  const { entries, parentId, modules, manifest } = opts;
  for (const entry of entries) {
    const id = routeIdFor(entry);
    manifest[id] = {
      id,
      parentId,
      path: entry.path,
      index: entry.index,
      caseSensitive: entry.caseSensitive,
      module: (modules[entry.file] ?? {}) as ServerRouteModule,
    };
    addEntries({ entries: entry.children ?? [], parentId: id, modules, manifest });
  }
}

/** The ServerBuild route manifest for every route in app/routes.ts, plus a root. */
export function buildServerRoutes(opts: { modules: Readonly<Record<string, unknown>> }): ServerRouteManifest {
  const manifest: ServerRouteManifest = {
    [ROOT_ID]: {
      id: ROOT_ID,
      path: '',
      module: { default: () => null } as unknown as ServerRouteModule,
    },
  };
  addEntries({ entries: routeConfig as RouteConfigEntry[], parentId: ROOT_ID, modules: opts.modules, manifest });
  return manifest;
}

/**
 * Build the handler. `modules` maps a route file as written in app/routes.ts
 * (for example `routes/_api.tsx`) to its imported module.
 */
export function createApiHandler(opts: {
  modules: Readonly<Record<string, unknown>>;
}): (request: Request) => Promise<Response> {
  const build: ServerBuild = {
    entry: {
      module: {
        // Only a document request (a path no resource route serves) reaches
        // this. The status is what the test reads.
        default: (_request, status, headers) => new Response(null, { status, headers }),
      },
    },
    routes: buildServerRoutes({ modules: opts.modules }),
    assets: { entry: { imports: [], module: '' }, routes: {}, url: '', version: 'test' },
    publicPath: '/',
    assetsBuildDirectory: '',
    future: { v8_middleware: true } as ServerBuild['future'],
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
  };
  const handler = createRequestHandler(build, 'production');
  return (request) => Promise.resolve(handler(request));
}
