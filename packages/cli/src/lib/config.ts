import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { getInvocationDir } from './invocation.js';

const ENV_FILE_NAME = '.env';

/** How many parent directories above the start directory are searched for a `.env` file. */
export const ENV_FILE_PARENT_LEVELS = 4;

/**
 * The directories searched for `.env` files, nearest first: the start
 * directory, then each parent, up to `ENV_FILE_PARENT_LEVELS` levels up.
 */
export function listEnvSearchDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  for (let level = 0; level <= ENV_FILE_PARENT_LEVELS; level += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/**
 * Loads `.env` files into `env` without overriding anything.
 *
 * The real process environment wins. Then the `.env` in the start directory
 * is applied, then each parent's, so the nearest file wins over a farther one.
 * A file entry with an empty value is skipped, so a blank line copied from an
 * `.env.example` never hides a real value in a farther file.
 *
 * Returns the files that were read, nearest first.
 */
export function loadEnvFiles(
  opts: { startDir?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const env = opts.env ?? process.env;
  const startDir = opts.startDir ?? getInvocationDir({ env });
  const loaded: string[] = [];

  for (const dir of listEnvSearchDirs(startDir)) {
    const file = path.join(dir, ENV_FILE_NAME);
    if (!existsSync(file) || !statSync(file).isFile()) continue;

    loaded.push(file);
    for (const [key, value] of Object.entries(parse(readFileSync(file, 'utf8')))) {
      if (value === '') continue;
      if (env[key] !== undefined) continue;
      env[key] = value;
    }
  }
  return loaded;
}

/**
 * Reads the base URL of the pigeon admin API from the environment.
 * There is no default: an admin tool must not guess which instance it talks to.
 */
export function getAdminUrl(): string {
  const url = process.env.PIGEON_ADMIN_URL;
  if (!url) {
    throw new Error(
      'PIGEON_ADMIN_URL is not set. Export it in your shell, or add it to a .env file in the ' +
        `current directory or up to ${ENV_FILE_PARENT_LEVELS} parent directories. See .env.example.`,
    );
  }
  return url;
}

/**
 * Reads the pigeon super-admin shared secret from the environment.
 *
 * Required for admin-scoped endpoints only (apps, keys). Domain endpoints
 * use a per-tenant API key instead, see resolveTenantKey().
 */
export function getAdminSecret(): string {
  const secret = process.env.PIGEON_ADMIN_SECRET;
  if (!secret) {
    throw new Error(
      'PIGEON_ADMIN_SECRET is not set. Export it in your shell, or add it to a .env file in the ' +
        `current directory or up to ${ENV_FILE_PARENT_LEVELS} parent directories. See .env.example.`,
    );
  }
  return secret;
}

/** The --key flag, else PIGEON_TENANT_KEY, else null. For callers that can go on without one. */
export function findTenantKey(flagValue: string | undefined): string | null {
  const key = flagValue ?? process.env.PIGEON_TENANT_KEY;
  return key ? key : null;
}

/**
 * Resolves the tenant-scoped API key used for domain endpoints.
 * Prefers the explicit --key flag; falls back to PIGEON_TENANT_KEY.
 */
export function resolveTenantKey(flagValue: string | undefined): string {
  const key = findTenantKey(flagValue);
  if (key === null) {
    throw new Error(
      'No tenant API key provided. Pass --key <ske_...> or set PIGEON_TENANT_KEY in your environment.',
    );
  }
  return key;
}
