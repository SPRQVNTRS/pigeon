import { isPoolReady, pool } from '#drizzle/db';
import { PIGEON_API_VERSION, PIGEON_API_VERSION_HEADER } from '#app/lib/api-version';

function respond(body: Record<string, unknown>, status: number): Response {
  return Response.json(
    { ...body, apiVersion: PIGEON_API_VERSION },
    { status, headers: { [PIGEON_API_VERSION_HEADER]: String(PIGEON_API_VERSION) } }
  );
}

export async function loader() {
  if (!isPoolReady) {
    return respond({ status: 'starting', check: 'database' }, 200);
  }
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB health check timeout')), 2000)
      ),
    ]);
    return respond({ status: 'ok', check: 'database' }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return respond({ status: 'error', check: 'database', message }, 503);
  }
}
