import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { resolveTenantKey } from '../lib/config.js';
import { printDnsRecordsTable } from '../lib/domain-output.js';
import { formatTable } from '../lib/formatters.js';
import { describeMailRouting, detectMailRouting } from '../lib/mail-routing.js';
import type { GlobalOpts } from './status.js';

const KEY_OPTION_DESCRIPTION = 'Tenant API key (ske_...); falls back to PIGEON_TENANT_KEY env var';

interface DomainKeyCliOpts {
  key?: string;
}

export function registerDomainsCommand(program: Command): void {
  const domains = program.command('domains').description('Manage tenant sending domains');

  domains
    .command('register <domain>')
    .description('Register a new sending domain for a tenant')
    .option('--key <apiKey>', KEY_OPTION_DESCRIPTION)
    .action(async (domain: string, cliOpts: DomainKeyCliOpts, command: Command) => {
      await registerDomainCommand({
        domain,
        key: cliOpts.key,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });

  domains
    .command('list')
    .description('List all sending domains registered for a tenant')
    .option('--key <apiKey>', KEY_OPTION_DESCRIPTION)
    .action(async (cliOpts: DomainKeyCliOpts, command: Command) => {
      await listDomainsCommand({
        key: cliOpts.key,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });

  domains
    .command('get <id>')
    .description('Fetch a registered domain by id')
    .option('--key <apiKey>', KEY_OPTION_DESCRIPTION)
    .action(async (id: string, cliOpts: DomainKeyCliOpts, command: Command) => {
      await getDomainCommand({
        id,
        key: cliOpts.key,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });

  domains
    .command('verify <id>')
    .description('Trigger SPF/DKIM/DMARC/MX verification for a domain')
    .option('--key <apiKey>', KEY_OPTION_DESCRIPTION)
    .action(async (id: string, cliOpts: DomainKeyCliOpts, command: Command) => {
      await verifyDomainCommand({
        id,
        key: cliOpts.key,
        globalOpts: command.optsWithGlobals<GlobalOpts>(),
      });
    });
}

async function registerDomainCommand(opts: {
  domain: string;
  key: string | undefined;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const tenantKey = resolveTenantKey(opts.key);

  const result = await client.registerDomain({ tenantKey, domain: opts.domain });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const routing = await detectMailRouting({ domain: result.domain.name, assumeGoogleWorkspace: false });
  console.log(`Registered domain "${result.domain.name}" (id: ${result.domain.id})`);
  console.log(`${describeMailRouting(routing)}\n`);
  printDnsRecordsTable({ records: result.dnsRecords, routing });
}

async function listDomainsCommand(opts: {
  key: string | undefined;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const tenantKey = resolveTenantKey(opts.key);

  const result = await client.listDomains({ tenantKey });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.domains.length === 0) {
    console.log('No domains found.');
    return;
  }

  const rows = result.domains.map((d) => [
    d.id,
    d.name,
    d.spfStatus,
    d.dkimStatus,
    d.dmarcStatus,
    d.mxStatus,
    d.verifiedAt ?? 'not yet verified',
  ]);
  console.log(formatTable(['ID', 'Name', 'SPF', 'DKIM', 'DMARC', 'MX', 'Verified At'], rows));
}

async function getDomainCommand(opts: {
  id: string;
  key: string | undefined;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const tenantKey = resolveTenantKey(opts.key);

  const result = await client.getDomain({ tenantKey, id: opts.id });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Domain "${result.domain.name}" (id: ${result.domain.id})`);
  console.log(
    `  SPF: ${result.domain.spfStatus}  DKIM: ${result.domain.dkimStatus}  ` +
      `DMARC: ${result.domain.dmarcStatus}  MX: ${result.domain.mxStatus}`,
  );
  console.log(`  Verified at: ${result.domain.verifiedAt ?? 'not yet verified'}`);
  const routing = await detectMailRouting({ domain: result.domain.name, assumeGoogleWorkspace: false });
  console.log(`${describeMailRouting(routing)}\n`);
  printDnsRecordsTable({ records: result.dnsRecords, routing });
}

async function verifyDomainCommand(opts: {
  id: string;
  key: string | undefined;
  globalOpts: GlobalOpts;
}): Promise<void> {
  const client = new PigeonClient();
  const tenantKey = resolveTenantKey(opts.key);

  const result = await client.verifyDomain({ tenantKey, id: opts.id });

  if (opts.globalOpts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    result.success
      ? `Verification triggered for domain ${result.domainId}.`
      : `Verification request completed but reported failure for domain ${result.domainId}.`,
  );
}
