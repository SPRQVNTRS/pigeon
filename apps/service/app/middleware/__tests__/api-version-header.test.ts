import { describe, it, expect } from 'vitest';
import { PIGEON_API_VERSION, PIGEON_API_VERSION_HEADER } from '#app/lib/api-version';
import { apiVersionHeaderMiddleware } from '../api-version-header';

type MiddlewareArgs = Parameters<typeof apiVersionHeaderMiddleware>;

async function run(response: Response): Promise<Response | void> {
  const args = {} as MiddlewareArgs[0];
  return apiVersionHeaderMiddleware(args, async () => response);
}

describe('apiVersionHeaderMiddleware', () => {
  it('sets the version header on a normal response', async () => {
    const result = await run(Response.json({ ok: true }));
    expect(result?.headers.get(PIGEON_API_VERSION_HEADER)).toBe(String(PIGEON_API_VERSION));
  });

  it('sets the version header on an auth failure returned by an inner middleware', async () => {
    const result = await run(
      Response.json({ error: { code: 'unauthorized' } }, { status: 401 }),
    );
    expect(result?.status).toBe(401);
    expect(result?.headers.get(PIGEON_API_VERSION_HEADER)).toBe(String(PIGEON_API_VERSION));
  });
});
