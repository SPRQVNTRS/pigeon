#!/usr/bin/env -S node --import tsx
import { Command } from 'commander';
import { registerStatusCommand } from './commands/status.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerKeysCommand } from './commands/keys.js';
import { registerDomainsCommand } from './commands/domains.js';
import { registerOnboardCommand } from './commands/onboard.js';
import { registerWebhooksCommand } from './commands/webhooks.js';
import { registerInboundCommand, registerInboundDomainsCommand } from './commands/inbound.js';
import { registerManifestCommand } from './commands/manifest.js';
import { SUPPORTED_API } from './lib/api-version.js';
import { loadEnvFiles } from './lib/config.js';
import { PigeonClient } from './lib/pigeon-client.js';
import { installVersionGuard } from './lib/version-guard.js';
import { EXIT_STATE_CONFLICT, isStateConflict } from './lib/state-version.js';

// The real process env wins. Then .env files are read without override: the one in
// the directory the command ran from, then each parent, up to 4 levels (see lib/config.ts).
loadEnvFiles();

const program = new Command();

program
  .name('pigeon')
  .description('Admin CLI for a Pigeon transactional email service')
  .version('0.1.0')
  .option('--json', 'Output raw JSON', false);

registerStatusCommand(program);
registerAppsCommand(program);
registerKeysCommand(program);
registerDomainsCommand(program);
registerOnboardCommand(program);
registerWebhooksCommand(program);
registerInboundDomainsCommand(program);
registerInboundCommand(program);
registerManifestCommand(program);

// Runs before every command that talks to the server. No flag or env var turns it off.
installVersionGuard(program, {
  fetchApiVersion: () => new PigeonClient().fetchApiVersion(),
  supported: SUPPORTED_API,
});

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  // 30: the app changed underneath a guarded command (a 412, or --state-version did not match).
  process.exitCode = isStateConflict(error) ? EXIT_STATE_CONFLICT : 1;
});
