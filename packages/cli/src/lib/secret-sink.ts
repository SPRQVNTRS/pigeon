import { assertValidVaultName, resolveFleetPath } from './bay-vault.js';
import type { VaultTarget } from './bay-vault.js';

export const DEFAULT_VAULT_ENV = 'production';

export interface SecretSinkCliOpts {
  secretStdout?: boolean;
  vault?: string;
  vaultEnv: string;
  /** Set only when the user passed --fleet. */
  fleet?: string;
}

export type SecretSink =
  | { kind: 'stdout' }
  | { kind: 'vault'; target: VaultTarget; isFleetExplicit: boolean };

/**
 * Picks the one place the signing secret goes. Every refusal happens here,
 * before any API call, so no secret is minted and lost.
 */
export function resolveSecretSink(opts: {
  cliOpts: SecretSinkCliOpts;
  isJson: boolean;
  isStdoutTty: boolean;
}): SecretSink {
  const { cliOpts } = opts;
  const hasStdout = cliOpts.secretStdout === true;
  const hasVault = cliOpts.vault !== undefined;

  if (hasStdout && hasVault) {
    throw new Error('Use only one of --secret-stdout and --vault. Pass exactly one secret sink.');
  }
  if (!hasStdout && !hasVault) {
    throw new Error(
      'Pass exactly one secret sink: --secret-stdout or --vault <NAME>. The server shows the secret once, and the CLI never prints it to a terminal.',
    );
  }

  if (hasStdout) {
    if (cliOpts.fleet !== undefined) throw new Error('--fleet only works with --vault.');
    if (opts.isJson) {
      throw new Error('--secret-stdout cannot be combined with --json. Stdout carries only the secret.');
    }
    if (opts.isStdoutTty) {
      throw new Error(
        'Refusing --secret-stdout on a terminal. Capture it instead: SECRET=$(pigeon webhooks ... --secret-stdout)',
      );
    }
    return { kind: 'stdout' };
  }

  const name = cliOpts.vault ?? '';
  assertValidVaultName(name);
  const fleet = resolveFleetPath(cliOpts.fleet);
  return {
    kind: 'vault',
    target: { name, env: cliOpts.vaultEnv, fleet },
    isFleetExplicit: cliOpts.fleet !== undefined,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The sink flags as the user would type them again. Used in recovery commands. */
export function describeSinkFlags(sink: SecretSink): string {
  if (sink.kind === 'stdout') return '--secret-stdout';

  const flags = [`--vault ${shellQuote(sink.target.name)}`];
  if (sink.target.env !== DEFAULT_VAULT_ENV) flags.push(`--vault-env ${shellQuote(sink.target.env)}`);
  if (sink.isFleetExplicit) flags.push(`--fleet ${shellQuote(sink.target.fleet)}`);
  return flags.join(' ');
}
