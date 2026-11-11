import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import { createUniqueApp } from '../lib/apps.js';
import {
  assertValidVaultName,
  createRunBay,
  preflightVault,
  resolveFleetPath,
  storeVaultSecret,
} from '../lib/bay-vault.js';
import type { RunBay, VaultTarget } from '../lib/bay-vault.js';
import { printDnsRecordsTable } from '../lib/domain-output.js';
import { describeMailRouting, detectMailRouting } from '../lib/mail-routing.js';
import type { GlobalOpts } from './status.js';

const PRODUCTION_KEY_NAME = 'production';
const DEFAULT_VAULT_ENV = 'production';

interface OnboardCliOpts {
  receivesMail: boolean;
  vault?: string;
  vaultEnv: string;
  fleet?: string;
}

interface VaultOutcome {
  target: VaultTarget;
  isStored: boolean;
}

export function registerOnboardCommand(program: Command): void {
  program
    .command('onboard <slug> <domain>')
    .description('Full flow: create app, production key, and register sending domain')
    .option(
      '--receives-mail',
      'Assume Google Workspace inbound even before its MX is published (the live MX is always checked)',
      false,
    )
    .option('--vault <name>', 'Store the new key in the Bay vault under this name and never print it')
    .option('--vault-env <env>', 'Bay vault environment for --vault', DEFAULT_VAULT_ENV)
    .option('--fleet <path>', 'Bay fleet directory for --vault (default: $PIGEON_BAY_FLEET)')
    .action(async (slug: string, domain: string, cliOpts: OnboardCliOpts, command: Command) => {
      await onboard({
        slug,
        domain,
        receivesMail: cliOpts.receivesMail,
        vault: resolveVaultTarget(cliOpts),
        runBay: createRunBay(),
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });
}

/** Validates the vault flags before any API call. Null when --vault is not set. */
function resolveVaultTarget(cliOpts: OnboardCliOpts): VaultTarget | null {
  if (cliOpts.vault === undefined) return null;

  assertValidVaultName(cliOpts.vault);
  const fleet = resolveFleetPath(cliOpts.fleet);
  return { name: cliOpts.vault, env: cliOpts.vaultEnv, fleet };
}

function printKeyBlock(plaintext: string): void {
  console.log('\n=== STORE THIS KEY NOW, it will not be shown again ===');
  console.log(plaintext);
  console.log('========================================================\n');
}

/**
 * Stores the key and reports the result. A failed write or read-back never
 * loses the key: it falls back to printing it, like a run without --vault.
 */
async function storeKeyInVault(opts: {
  runBay: RunBay;
  target: VaultTarget;
  slug: string;
  plaintext: string;
}): Promise<VaultOutcome> {
  const { target } = opts;
  try {
    await storeVaultSecret({ runBay: opts.runBay, target, value: opts.plaintext });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: could not store the key in the Bay vault. ${message}\n`);
    printKeyBlock(opts.plaintext);
    return { target, isStored: false };
  }

  console.log(`Stored the key in the Bay vault as ${target.name} (${target.env}). The key is not shown.`);
  console.log(
    `Commit and push only group_vars/${target.env}/secrets.yml in the fleet repo: ` +
      `vault(${target.env}): ${opts.slug} Pigeon API key`,
  );
  return { target, isStored: true };
}

function toJsonOutput(opts: {
  app: unknown;
  apiKey: unknown;
  plaintext: string;
  registration: unknown;
  vault: VaultOutcome | null;
}): Record<string, unknown> {
  const { app, apiKey, plaintext, registration, vault } = opts;
  if (vault === null) return { app, apiKey, plaintext, registration };

  const vaultJson = { name: vault.target.name, env: vault.target.env, stored: vault.isStored };
  if (vault.isStored) return { app, apiKey, registration, vault: vaultJson };
  return { app, apiKey, plaintext, registration, vault: vaultJson };
}

export async function onboard(opts: {
  slug: string;
  domain: string;
  receivesMail: boolean;
  vault: VaultTarget | null;
  runBay: RunBay;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const adminSecret = getAdminSecret();

  if (opts.vault) await preflightVault({ runBay: opts.runBay, target: opts.vault });

  const { app } = await createUniqueApp({ client, adminSecret, name: opts.slug, force: false });
  console.log(`Created app "${app.name}" (id: ${app.id})`);

  const { apiKey, plaintext } = await client.createApiKey({
    adminSecret,
    appId: app.id,
    name: PRODUCTION_KEY_NAME,
  });
  console.log(`Created API key "${apiKey.name}" (prefix: ${apiKey.prefix})`);

  const vault = opts.vault
    ? await storeKeyInVault({ runBay: opts.runBay, target: opts.vault, slug: opts.slug, plaintext })
    : null;
  if (vault && !vault.isStored) process.exitCode = 1;

  const registration = await client.registerDomain({ tenantKey: plaintext, domain: opts.domain });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(toJsonOutput({ app, apiKey, plaintext, registration, vault }), null, 2));
    return;
  }

  console.log(`Registered domain "${registration.domain.name}" (id: ${registration.domain.id})`);
  if (vault === null) printKeyBlock(plaintext);

  const routing = await detectMailRouting({ domain: opts.domain, assumeGoogleWorkspace: opts.receivesMail });
  console.log(`DNS records for ${registration.domain.name}:`);
  console.log(`${describeMailRouting(routing)}\n`);
  printDnsRecordsTable({ records: registration.dnsRecords, routing });
}
