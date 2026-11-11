import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFromInvocationDir } from './invocation.js';

/**
 * Stores a secret in the Bay vault through the `bay` CLI.
 *
 * The value goes to `bay vault set` on stdin, never as an argument: argv is
 * readable in /proc/<pid>/cmdline by any local user. `bay vault view` prints
 * the whole decrypted vault, so its stdout is parsed in memory and never
 * logged. Errors carry the bay exit code and a redacted stderr only.
 */

const VAULT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TENANT_KEY_PATTERN = /ske_[^\s'"]+/g;

export interface BayResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs one bay command. Injectable so tests can swap the real CLI out. */
export type RunBay = (opts: { args: string[]; stdin?: string }) => Promise<BayResult>;

export interface VaultTarget {
  name: string;
  env: string;
  fleet: string;
}

export function assertValidVaultName(name: string): void {
  if (VAULT_NAME_PATTERN.test(name)) return;
  throw new Error(
    `Invalid vault key name "${name}". Use upper case letters, digits and underscores, ` +
      'starting with a letter (for example MYAPP_PIGEON_API_KEY).',
  );
}

export const FLEET_ENV_VAR = 'PIGEON_BAY_FLEET';

/**
 * The Bay fleet directory for `--vault`: the `--fleet` flag, else
 * `PIGEON_BAY_FLEET`. There is no default path. A relative path is taken
 * from the directory the command was run from. Throws when neither is set,
 * or when the directory does not exist.
 */
export function resolveFleetPath(
  flagValue: string | undefined,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  const env = opts.env ?? process.env;
  const raw = flagValue ?? (env[FLEET_ENV_VAR] || undefined);
  if (raw === undefined) {
    throw new Error(
      `--vault needs a Bay fleet directory. Pass --fleet <path> or set ${FLEET_ENV_VAR}. ` +
        'Nothing was created.',
    );
  }
  const fleet = resolveFromInvocationDir(raw, { env, cwd: opts.cwd });
  assertFleetExists(fleet);
  return fleet;
}

export function assertFleetExists(fleet: string): void {
  if (existsSync(fleet) && statSync(fleet).isDirectory()) return;
  throw new Error(`Bay fleet directory not found: ${fleet}. Pass --fleet <path> or set ${FLEET_ENV_VAR}.`);
}

export function redactTenantKeys(text: string): string {
  return text.replace(TENANT_KEY_PATTERN, 'ske_<redacted>');
}

function isOnPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(path.join(dir, binary)));
}

/** BAY_BIN, else `bay` on PATH, else ~/.local/bin/bay, else plain `bay`. */
export function resolveBayBin(): string {
  if (process.env.BAY_BIN) return process.env.BAY_BIN;
  if (isOnPath('bay')) return 'bay';

  const localBin = path.join(os.homedir(), '.local', 'bin', 'bay');
  if (existsSync(localBin)) return localBin;
  return 'bay';
}

/** Spawns the bay binary without a shell and buffers its output in memory. */
export function createRunBay(bayBin: string = resolveBayBin()): RunBay {
  return (opts) =>
    new Promise<BayResult>((resolve, reject) => {
      const child = spawn(bayBin, opts.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => reject(new Error(`Could not run bay (${bayBin}): ${error.message}`)));
      child.on('close', (code) =>
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );

      child.stdin.on('error', () => {
        // bay may exit before reading stdin; the exit code reports the failure.
      });
      child.stdin.end(opts.stdin ?? '');
    });
}

function bayFailure(opts: { command: string; result: BayResult }): Error {
  const stderr = redactTenantKeys(opts.result.stderr).trim();
  const detail = stderr ? `\n${stderr}` : '';
  return new Error(`bay ${opts.command} failed (exit ${opts.result.exitCode}).${detail}`);
}

function unquote(value: string): string {
  const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) return value.slice(1, -1);
  return value;
}

/**
 * Reads the keys under the top-level `secrets:` mapping of `bay vault view`.
 * Only single-line `KEY: value` entries carry a value; a key with a block
 * value still counts as present.
 */
export function parseVaultSecrets(yaml: string): Map<string, string> {
  const secrets = new Map<string, string>();
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^secrets:\s*$/.test(line));
  if (start === -1) return secrets;

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;

    const match = /^ {1,4}([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    secrets.set(match[1] ?? '', unquote((match[2] ?? '').trim()));
  }
  return secrets;
}

async function viewVault(opts: { runBay: RunBay; target: VaultTarget }): Promise<Map<string, string>> {
  const command = `vault view ${opts.target.env}`;
  const result = await opts.runBay({ args: ['--fleet', opts.target.fleet, 'vault', 'view', opts.target.env] });
  if (result.exitCode !== 0) throw bayFailure({ command, result });
  return parseVaultSecrets(result.stdout);
}

/**
 * Checks that the vault opens and that the target name is free.
 * Runs before any pigeon API call, so a refusal creates nothing.
 * With `allowExisting`, it only checks that the vault opens. A rotate
 * replaces a secret that already lives under the name.
 */
export async function preflightVault(opts: {
  runBay: RunBay;
  target: VaultTarget;
  allowExisting?: boolean;
}): Promise<void> {
  const secrets = await viewVault(opts);
  if (opts.allowExisting) return;
  if (!secrets.has(opts.target.name)) return;

  throw new Error(
    `The Bay vault (${opts.target.env}) already holds ${opts.target.name}. Refusing to overwrite it. ` +
      'Choose another --vault name, or remove the old key with `bay vault edit` first.',
  );
}

/** Writes the value on stdin, then reads the vault back and compares. */
export async function storeVaultSecret(opts: {
  runBay: RunBay;
  target: VaultTarget;
  value: string;
}): Promise<void> {
  const { target } = opts;
  const command = `vault set ${target.env} ${target.name}`;
  const result = await opts.runBay({
    args: ['--fleet', target.fleet, 'vault', 'set', target.env, target.name],
    stdin: opts.value,
  });
  if (result.exitCode !== 0) throw bayFailure({ command, result });

  const secrets = await viewVault({ runBay: opts.runBay, target });
  if (secrets.get(target.name) === opts.value) return;

  throw new Error(
    `Read-back check failed: the vault value for ${target.name} (${target.env}) does not match the new key.`,
  );
}
