/**
 * The pigeon API contract versions this CLI can talk to.
 *
 * The service reports its version as `apiVersion` in the `/healthz` body (see
 * `PIGEON_API_VERSION` in `pigeon/apps/service/app/lib/api-version.ts`).
 * Change `SUPPORTED_API` together with `PIGEON_API_VERSION`: raise `max` when
 * this CLI learns the new contract, raise `min` when it drops the old one.
 */
export const SUPPORTED_API = { min: 1, max: 1 } as const;

export interface SupportedApiRange {
  min: number;
  max: number;
}

export type ApiVersionCheck =
  | { outcome: 'ok' }
  | { outcome: 'cli-stale'; message: string }
  | { outcome: 'server-old'; message: string }
  | { outcome: 'malformed'; message: string }
  /** The server reports no version, so it predates the handshake. A different cause than `server-old`. */
  | { outcome: 'unknown'; message: string };

/** Every outcome except `ok` stops the command. */
export function isRefusal(check: ApiVersionCheck): check is Exclude<ApiVersionCheck, { outcome: 'ok' }> {
  return check.outcome !== 'ok';
}

function isValidVersion(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Pure. Compares the version the server reports with the range this CLI supports. */
export function checkApiVersion(opts: {
  serverVersion: number | null;
  supported: SupportedApiRange;
}): ApiVersionCheck {
  const { serverVersion, supported } = opts;

  if (serverVersion === null) {
    return {
      outcome: 'unknown',
      message:
        'The pigeon server reports no API version, so it is older than this CLI. ' +
        'Deploy the current pigeon service, or use an older checkout of the workspace.',
    };
  }
  if (!isValidVersion(serverVersion)) {
    return {
      outcome: 'malformed',
      message:
        'The pigeon server reported an API version that is not a positive whole number. ' +
        'The CLI will not run against it. Check the server deploy.',
    };
  }
  if (serverVersion > supported.max) {
    return {
      outcome: 'cli-stale',
      message:
        `This CLI is older than the pigeon server. The server speaks API version ${serverVersion}. ` +
        `This CLI supports versions ${formatRange(supported)}. ` +
        'Run git pull in the workspace checkout to update it, then run the command again.',
    };
  }
  if (serverVersion < supported.min) {
    return {
      outcome: 'server-old',
      message:
        `The pigeon server is older than this CLI. The server speaks API version ${serverVersion}. ` +
        `This CLI supports versions ${formatRange(supported)}. ` +
        'Deploy pigeon to the current version, or use an older workspace checkout.',
    };
  }
  return { outcome: 'ok' };
}

export function formatRange(range: SupportedApiRange): string {
  return range.min === range.max ? String(range.min) : `${range.min} to ${range.max}`;
}
