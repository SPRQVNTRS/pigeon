import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import { SUPPORTED_API, formatRange } from '../lib/api-version.js';

export interface GlobalOpts {
  json: boolean;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check admin API reachability (GET /v1/admin/apps)')
    .action(async (_opts: unknown, command: Command) => {
      await statusCommand(command.optsWithGlobals<GlobalOpts>());
    });
}

async function statusCommand(opts: GlobalOpts): Promise<void> {
  const client = new PigeonClient();
  const adminSecret = getAdminSecret();

  const { status, apps } = await client.listApps({ adminSecret });
  const serverApiVersion = await client.fetchApiVersion();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          httpStatus: status,
          appCount: apps.length,
          serverApiVersion,
          supportedApi: { min: SUPPORTED_API.min, max: SUPPORTED_API.max },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Pigeon admin API reachable, HTTP ${status}, ${apps.length} app(s) registered.`);
  console.log(
    `API version: server ${serverApiVersion ?? 'not reported'}, this CLI supports ${formatRange(SUPPORTED_API)}.`,
  );
}
