/**
 * /healthz and /healthcheck carry the API contract version in the body and in
 * the Pigeon-Api-Version header, on every answer (mock DB, no connection).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PIGEON_API_VERSION, PIGEON_API_VERSION_HEADER } from '#app/lib/api-version';

const dbState = vi.hoisted(() => ({
  isReady: true,
  query: async (): Promise<unknown> => ({ rows: [] }),
}));

vi.mock('#drizzle/db', () => ({
  get isPoolReady() {
    return dbState.isReady;
  },
  pool: { query: () => dbState.query() },
}));

const healthz = await import('../healthz');
const healthcheck = await import('../healthcheck');

beforeEach(() => {
  dbState.isReady = true;
  dbState.query = async () => ({ rows: [] });
});

describe.each([
  ['healthz', healthz],
  ['healthcheck', healthcheck],
])('%s loader', (_name, route) => {
  it('reports the version while the pool is starting', async () => {
    dbState.isReady = false;
    const response = await route.loader();
    expect(response.status).toBe(200);
    expect(response.headers.get(PIGEON_API_VERSION_HEADER)).toBe(String(PIGEON_API_VERSION));
    expect(await response.json()).toEqual({
      status: 'starting',
      check: 'database',
      apiVersion: PIGEON_API_VERSION,
    });
  });

  it('reports the version when the database answers', async () => {
    const response = await route.loader();
    expect(response.status).toBe(200);
    expect(response.headers.get(PIGEON_API_VERSION_HEADER)).toBe(String(PIGEON_API_VERSION));
    expect(await response.json()).toEqual({
      status: 'ok',
      check: 'database',
      apiVersion: PIGEON_API_VERSION,
    });
  });

  it('reports the version on a 503 when the database fails', async () => {
    dbState.query = async () => {
      throw new Error('connection refused');
    };
    const response = await route.loader();
    expect(response.status).toBe(503);
    expect(response.headers.get(PIGEON_API_VERSION_HEADER)).toBe(String(PIGEON_API_VERSION));
    expect(await response.json()).toEqual({
      status: 'error',
      check: 'database',
      message: 'connection refused',
      apiVersion: PIGEON_API_VERSION,
    });
  });
});
