import type { Command } from 'commander';
import {
  checkApiVersion,
  isRefusal,
  type SupportedApiRange,
} from './api-version.js';

/**
 * Command paths that never talk to the server. The version check skips them.
 * This is the only exemption list. A command that is not listed here is checked,
 * so a new command is safe by default.
 */
export const OFFLINE_COMMAND_PATHS: readonly string[] = ['manifest validate'];

/** The server and this CLI do not speak the same API version. The command did not run. */
export class ApiVersionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiVersionRefusedError';
  }
}

export interface VersionGuardDeps {
  fetchApiVersion: () => Promise<number | null>;
  supported: SupportedApiRange;
}

/** `manifest validate` for the validate subcommand of manifest. The root program is left out. */
export function getCommandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current !== null && current.parent !== null) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(' ');
}

/**
 * Runs before every command action on `program`. One GET /healthz, nothing else.
 * Refuses (throws) when the server cannot be read, reports no version, or the versions do not match.
 * Nothing turns it off.
 */
export function installVersionGuard(program: Command, deps: VersionGuardDeps): void {
  program.hook('preAction', async (_hooked, actionCommand) => {
    if (OFFLINE_COMMAND_PATHS.includes(getCommandPath(actionCommand))) return;

    const serverVersion = await deps.fetchApiVersion();
    const check = checkApiVersion({ serverVersion, supported: deps.supported });

    if (isRefusal(check)) throw new ApiVersionRefusedError(check.message);
  });
}
