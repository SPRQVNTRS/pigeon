import type { PigeonClient, WithStateVersion } from './pigeon-client.js';
import { PigeonHttpError } from './http-errors.js';
import type { PigeonApp } from './types.js';

/** The code POST /v1/admin/apps answers with 409 when another app has the name. */
export const APP_NAME_TAKEN_CODE = 'app_name_taken';

/**
 * Another app already has the name. Thrown by the client-side check and for
 * the server's 409, with one message, so both end the same way: the command
 * prints it and exits 1.
 */
export class AppAlreadyExistsError extends Error {
  constructor(opts: { name: string; id: string | null }) {
    super(`An app named "${opts.name}" already exists${opts.id ? ` (id: ${opts.id})` : ''}. App names are unique.`);
    this.name = 'AppAlreadyExistsError';
  }
}

/**
 * The client-side check before a create: throws AppAlreadyExistsError if an
 * app with the given name exists, unless `force` is set. The server enforces
 * unique names too (a 409), so `force` only skips this extra round trip; it
 * cannot create a duplicate.
 */
export async function assertUniqueAppName(opts: {
  client: Pick<PigeonClient, 'listApps'>;
  adminSecret: string;
  name: string;
  force: boolean;
}): Promise<void> {
  if (opts.force) return;

  const { apps } = await opts.client.listApps({ adminSecret: opts.adminSecret });
  const existing = apps.find((app) => app.name === opts.name);
  if (!existing) return;

  throw new AppAlreadyExistsError({ name: opts.name, id: existing.id });
}

function isAppNameTaken(error: unknown): boolean {
  return error instanceof PigeonHttpError && error.status === 409 && error.code === APP_NAME_TAKEN_CODE;
}

/** Looks up the id of the app that won, for the message. A failed lookup only drops the id. */
async function existingAppId(opts: {
  client: Pick<PigeonClient, 'listApps'>;
  adminSecret: string;
  name: string;
}): Promise<string | null> {
  try {
    const { apps } = await opts.client.listApps({ adminSecret: opts.adminSecret });
    return apps.find((app) => app.name === opts.name)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Create an app with a name no other app has: the client-side check, then the
 * create. When another process creates the same name between the two, the
 * server answers 409 and this throws the same AppAlreadyExistsError as the
 * check, so every command keeps one duplicate behaviour.
 */
export async function createUniqueApp(opts: {
  client: Pick<PigeonClient, 'listApps' | 'createApp'>;
  adminSecret: string;
  name: string;
  force: boolean;
}): Promise<WithStateVersion<{ app: PigeonApp }>> {
  await assertUniqueAppName(opts);
  try {
    return await opts.client.createApp({ adminSecret: opts.adminSecret, name: opts.name });
  } catch (error) {
    if (!isAppNameTaken(error)) throw error;
    throw new AppAlreadyExistsError({ name: opts.name, id: await existingAppId(opts) });
  }
}
