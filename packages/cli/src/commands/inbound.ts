import type { Command } from 'commander';
import { PigeonClient } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import { formatTable } from '../lib/formatters.js';
import type { GlobalOpts } from './status.js';

/**
 * Inbound mail admin verbs: `inbound-domains list|add` and `inbound list|replay`.
 * The server never returns a sender, subject, body or address here, and the
 * CLI prints ids, times and counts only.
 */

export interface InboundDeps {
  client: Pick<
    PigeonClient,
    'listInboundDomains' | 'addInboundDomain' | 'listInboundEmails' | 'replayInboundEmail'
  >;
  adminSecret: string;
  log: (text: string) => void;
}

const MAX_LIST_LIMIT = 200;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface ListCliOpts {
  limit?: string;
}

function buildDeps(): InboundDeps {
  return {
    client: new PigeonClient(),
    adminSecret: getAdminSecret(),
    log: (text) => {
      process.stdout.write(`${text}\n`);
    },
  };
}

export function registerInboundDomainsCommand(program: Command): void {
  const domains = program
    .command('inbound-domains')
    .description('Manage the domains an app receives mail on (admin)');

  domains
    .command('list <appId>')
    .description('List the inbound domains of an app')
    .action(async (appId: string, _cliOpts: unknown, command: Command) => {
      await listInboundDomainsCommand({
        appId,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });

  domains
    .command('add <appId> <domain>')
    .description('Register an inbound domain for an app. SES receiving is set up separately')
    .action(async (appId: string, domain: string, _cliOpts: unknown, command: Command) => {
      await addInboundDomainCommand({
        appId,
        domain,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });
}

export function registerInboundCommand(program: Command): void {
  const inbound = program.command('inbound').description('Inspect and replay received mail (admin)');

  inbound
    .command('list <appId>')
    .description('List received mail of an app: ids, times and recipient counts only')
    .option('--limit <n>', `How many rows, 1 to ${MAX_LIST_LIMIT} (server default 50)`)
    .action(async (appId: string, cliOpts: ListCliOpts, command: Command) => {
      await listInboundEmailsCommand({
        appId,
        limit: cliOpts.limit,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });

  inbound
    .command('replay <appId> <inboundEmailId>')
    .description('Send the email.received webhooks of a received mail again')
    .action(async (appId: string, inboundEmailId: string, _cliOpts: unknown, command: Command) => {
      await replayInboundEmailCommand({
        appId,
        inboundEmailId,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });
}

/** Lowercases and trims the domain, and drops a trailing dot. Throws before any API call. */
export function parseInboundDomain(raw: string): string {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`Not a domain name: ${raw}. Pass a bare domain such as reply.example.com.`);
  }
  return domain;
}

/** Throws on a value the server would refuse, before any API call. */
export function parseListLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`--limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

export async function listInboundDomainsCommand(opts: {
  appId: string;
  isJson: boolean;
  deps: InboundDeps;
}): Promise<void> {
  const { deps } = opts;
  const { inboundDomains } = await deps.client.listInboundDomains({
    adminSecret: deps.adminSecret,
    appId: opts.appId,
  });

  if (opts.isJson) {
    deps.log(JSON.stringify(inboundDomains, null, 2));
    return;
  }
  if (inboundDomains.length === 0) {
    deps.log('No inbound domains found.');
    return;
  }

  const rows = inboundDomains.map((domain) => [
    domain.id,
    domain.name,
    domain.region,
    domain.enabled ? 'yes' : 'no',
    domain.createdAt,
  ]);
  deps.log(formatTable(['ID', 'Domain', 'Region', 'Enabled', 'Created'], rows));
}

export async function addInboundDomainCommand(opts: {
  appId: string;
  domain: string;
  isJson: boolean;
  deps: InboundDeps;
}): Promise<void> {
  const { deps } = opts;
  const name = parseInboundDomain(opts.domain);
  const { inboundDomain } = await deps.client.addInboundDomain({
    adminSecret: deps.adminSecret,
    appId: opts.appId,
    name,
  });

  if (opts.isJson) {
    deps.log(JSON.stringify(inboundDomain, null, 2));
    return;
  }
  deps.log(
    `Inbound domain ${inboundDomain.name} added (${inboundDomain.id}). ` +
      'Mail arrives only after SES receiving is set up for it (scripts/aws-inbound.ts in pigeon).',
  );
}

export async function listInboundEmailsCommand(opts: {
  appId: string;
  limit: string | undefined;
  isJson: boolean;
  deps: InboundDeps;
}): Promise<void> {
  const { deps } = opts;
  const limit = parseListLimit(opts.limit);
  const { inboundEmails } = await deps.client.listInboundEmails({
    adminSecret: deps.adminSecret,
    appId: opts.appId,
    limit,
  });

  if (opts.isJson) {
    const summaries = inboundEmails.map((email) => ({
      id: email.id,
      receivedAt: email.receivedAt,
      recipientCount: email.recipientCount,
    }));
    deps.log(JSON.stringify(summaries, null, 2));
    return;
  }
  if (inboundEmails.length === 0) {
    deps.log('No received mail found.');
    return;
  }

  const rows = inboundEmails.map((email) => [
    email.id,
    email.receivedAt,
    String(email.recipientCount),
  ]);
  deps.log(
    formatTable(['ID', 'Received', 'Recipients'], rows, { align: ['left', 'left', 'right'] }),
  );
}

export async function replayInboundEmailCommand(opts: {
  appId: string;
  inboundEmailId: string;
  isJson: boolean;
  deps: InboundDeps;
}): Promise<void> {
  const { deps } = opts;
  const replay = await deps.client.replayInboundEmail({
    adminSecret: deps.adminSecret,
    appId: opts.appId,
    inboundEmailId: opts.inboundEmailId,
  });

  if (opts.isJson) {
    deps.log(JSON.stringify(replay, null, 2));
    return;
  }
  deps.log(`Inbound email ${replay.inboundEmailId} queued again (job ${replay.jobId}).`);
}
