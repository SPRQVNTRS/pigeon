import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import { createUniqueApp } from '../lib/apps.js';
import { formatTable } from '../lib/formatters.js';
import type { GlobalOpts } from './status.js';

interface CreateAppCliOpts {
  force: boolean;
}

export function registerAppsCommand(program: Command): void {
  const apps = program.command('apps').description('Manage pigeon apps (tenants)');

  apps
    .command('list')
    .description('List all pigeon apps')
    .action(async (_opts: unknown, command: Command) => {
      await listAppsCommand(command.optsWithGlobals<GlobalOpts>());
    });

  apps
    .command('create <name>')
    .description('Create a new pigeon app (tenant)')
    .option('--force', 'Skip the client-side name check (the server still refuses a duplicate name)', false)
    .action(async (name: string, cliOpts: CreateAppCliOpts, command: Command) => {
      await createAppCommand({
        name,
        force: cliOpts.force,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });
}

async function listAppsCommand(globalOpts: GlobalOpts): Promise<void> {
  const client = new PigeonClient();
  const adminSecret = getAdminSecret();

  const { apps } = await client.listApps({ adminSecret });

  if (globalOpts.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }

  if (apps.length === 0) {
    console.log('No apps found.');
    return;
  }

  const rows = apps.map((a) => [a.id, a.name, a.createdAt]);
  console.log(
    formatTable(['ID', 'Name', 'Created At'], rows, { align: ['left', 'left', 'left'] }),
  );
}

async function createAppCommand(opts: {
  name: string;
  force: boolean;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const adminSecret = getAdminSecret();

  const { app } = await createUniqueApp({ client, adminSecret, name: opts.name, force: opts.force });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(app, null, 2));
    return;
  }

  console.log(`Created app "${app.name}" (id: ${app.id})`);
}
