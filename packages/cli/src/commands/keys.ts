import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import type { GlobalOpts } from './status.js';

const DEFAULT_KEY_NAME = 'production';

interface CreateKeyCliOpts {
  name: string;
}

export function registerKeysCommand(program: Command): void {
  const keys = program.command('keys').description('Manage tenant API keys');

  keys
    .command('create <appId>')
    .description('Create a new API key for an app')
    .option('--name <name>', 'Key name', DEFAULT_KEY_NAME)
    .action(async (appId: string, cliOpts: CreateKeyCliOpts, command: Command) => {
      await createKeyCommand({
        appId,
        name: cliOpts.name,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });
}

async function createKeyCommand(opts: {
  appId: string;
  name: string;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const adminSecret = getAdminSecret();

  const { apiKey, plaintext } = await client.createApiKey({
    adminSecret,
    appId: opts.appId,
    name: opts.name,
  });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify({ apiKey, plaintext }, null, 2));
    return;
  }

  console.log('\n=== STORE THIS KEY NOW, it will not be shown again ===');
  console.log(plaintext);
  console.log('========================================================\n');
  console.log(
    `Key id: ${apiKey.id}  app: ${apiKey.appId}  name: ${apiKey.name}  prefix: ${apiKey.prefix}`,
  );
}
