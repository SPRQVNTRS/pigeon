/**
 * The state version of one app's configuration (see the service doc
 * apps/service/docs/concurrency.md).
 *
 * The server reports it in the `Pigeon-State-Version` header of every read
 * and write of one app's configuration. A guarded write sends it back in
 * `If-Match`. When the app changed in between, the server answers 412 and
 * changes nothing; the CLI then stops with EXIT_STATE_CONFLICT.
 */

import { PigeonHttpError } from './http-errors.js';

export const STATE_VERSION_HEADER = 'Pigeon-State-Version';

/** The app changed underneath a guarded command. Nothing was changed by the refused request. */
export const EXIT_STATE_CONFLICT = 30;

const VERSION_PATTERN = /^\d{1,10}$/;

/**
 * The server refused a guarded write with 412: the app is no longer at the
 * version the CLI sent. A PigeonHttpError (status 412), so code that passes a
 * clear 4xx through unchanged passes this one through too.
 */
export class StateVersionConflictError extends PigeonHttpError {
  readonly expected: number;
  readonly current: number;

  constructor(opts: { expected: number; current: number; message?: string }) {
    super({
      status: 412,
      code: 'state_version_mismatch',
      message:
        opts.message ??
        `The app changed underneath this command: it expected state version ${opts.expected}, ` +
          `the server is at ${opts.current}. The refused request changed nothing.`,
    });
    this.name = 'StateVersionConflictError';
    this.expected = opts.expected;
    this.current = opts.current;
  }
}

/** `--state-version <n>` does not match the version the CLI just read. Nothing was written. */
export class StateVersionPinError extends Error {
  readonly pinned: number;
  readonly current: number | null;

  constructor(opts: { pinned: number; current: number | null; message: string }) {
    super(opts.message);
    this.name = 'StateVersionPinError';
    this.pinned = opts.pinned;
    this.current = opts.current;
  }
}

export const SERVER_TOO_OLD_MESSAGE =
  'The server is too old for guarded writes: it sends no Pigeon-State-Version header. ' +
  'Nothing was written. Deploy the current pigeon service.';

/** A guarded command read the app and found no state version header. Nothing was written. */
export class ServerTooOldForGuardedWritesError extends Error {
  constructor() {
    super(SERVER_TOO_OLD_MESSAGE);
    this.name = 'ServerTooOldForGuardedWritesError';
  }
}

/** True for the errors that mean "the app changed underneath": exit code 30. */
export function isStateConflict(error: unknown): boolean {
  return error instanceof StateVersionConflictError || error instanceof StateVersionPinError;
}

/**
 * The header value as a number. Null when the header is absent (a server
 * older than the state version). Throws on a value that is not a whole number,
 * so a garbled header never becomes a guard.
 */
export function parseStateVersionHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(`The server sent a malformed ${STATE_VERSION_HEADER} header.`);
  }
  return Number(trimmed);
}

/** The value of `--state-version`: a whole number, 0 or more. */
export function parseStateVersionOption(raw: string): number {
  const trimmed = raw.trim();
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(`--state-version must be a whole number, 0 or more, not "${raw}".`);
  }
  return Number(trimmed);
}

/** The version a guarded write needs. Throws ServerTooOldForGuardedWritesError when the read had none. */
export function requireStateVersion(stateVersion: number | null): number {
  if (stateVersion === null) throw new ServerTooOldForGuardedWritesError();
  return stateVersion;
}

/** The If-Match header value for a version: the quoted entity-tag form. */
export function ifMatchValue(stateVersion: number): string {
  return `"${stateVersion}"`;
}

/**
 * Refuses unless the version just read equals the pinned one. Runs before the
 * first write, so a refusal changes nothing.
 */
export function assertPinnedStateVersion(opts: { pinned: number | undefined; current: number }): void {
  const { pinned, current } = opts;
  if (pinned === undefined || pinned === current) return;
  throw new StateVersionPinError({
    pinned,
    current,
    message:
      `The app is at state version ${current}, not ${pinned} (--state-version). ` +
      'It changed since that version was read. Nothing was written. Read it again, then run the command again.',
  });
}

/**
 * What one observation of an app tells about its state version.
 * - known: every configuration read carried the header; the value is the lowest one seen.
 * - no-app: the app does not exist yet, or its name is ambiguous.
 * - unsupported: a read had no header, so the server is too old for guarded writes.
 * - unread: no configuration section could be read at all.
 */
export type StateVersionReading =
  | { kind: 'known'; value: number }
  | { kind: 'no-app'; reason: string }
  | { kind: 'unsupported' }
  | { kind: 'unread' };

/**
 * Folds the versions of the reads of one observation into one reading.
 *
 * Each server list reads the version before its rows, so each list is at least
 * as new as the version it reports. The lowest version seen is therefore safe
 * to send as If-Match: if the app changed after any of the reads, the server is
 * past that version and refuses the write. When nothing changed, every read saw
 * exactly that version and the plan is exact.
 */
export function summarizeStateVersions(versions: ReadonlyArray<number | null>): StateVersionReading {
  if (versions.length === 0) return { kind: 'unread' };
  const known = versions.filter((version): version is number => version !== null);
  if (known.length < versions.length) return { kind: 'unsupported' };
  return { kind: 'known', value: Math.min(...known) };
}

/** One line for humans: the reading and why it may be missing. */
export function describeStateVersion(reading: StateVersionReading): string {
  switch (reading.kind) {
    case 'known':
      return `State version: ${reading.value}`;
    case 'no-app':
      return `State version: none (${reading.reason})`;
    case 'unsupported':
      return 'State version: unknown (the server sends no Pigeon-State-Version header; it is too old for guarded writes)';
    case 'unread':
      return 'State version: unknown (no section of the app could be read)';
    default: {
      const unreachable: never = reading;
      throw new Error(`Unknown state version reading: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The reading as a number for --json output: null unless it is known. */
export function stateVersionValue(reading: StateVersionReading): number | null {
  return reading.kind === 'known' ? reading.value : null;
}
