import type { Command } from 'commander';
import { PigeonClient, PigeonHttpError, WebhookExistsError } from '../lib/pigeon-client.js';
import { getAdminSecret } from '../lib/config.js';
import { createRunBay, preflightVault, storeVaultSecret } from '../lib/bay-vault.js';
import type { RunBay } from '../lib/bay-vault.js';
import { formatTable } from '../lib/formatters.js';
import { DEFAULT_VAULT_ENV, describeSinkFlags, resolveSecretSink } from '../lib/secret-sink.js';
import type { SecretSink, SecretSinkCliOpts } from '../lib/secret-sink.js';
import { WEBHOOK_EVENT_TYPES, parseEventTypes } from '../lib/webhook-events.js';
import type { PigeonWebhook, PigeonWebhookWithSecret } from '../lib/types.js';
import {
  StateVersionConflictError,
  assertPinnedStateVersion,
  parseStateVersionOption,
  requireStateVersion,
} from '../lib/state-version.js';
import type { GlobalOpts } from './status.js';

type SecretAction = 'create' | 'rotate';

/** Output channels. Tests swap these to prove where the secret does and does not go. */
export interface WebhookIo {
  /** Normal output (stdout). In --secret-stdout mode only the secret may use it. */
  log: (text: string) => void;
  /** Writes raw text to stdout and reports a write failure. Used for the secret only. */
  writeStdout: (text: string) => Promise<void>;
  /** Diagnostics (stderr). */
  writeStderr: (text: string) => void;
}

export interface WebhookDeps {
  client: Pick<
    PigeonClient,
    'listWebhooks' | 'createWebhook' | 'rotateWebhookSecret' | 'updateWebhookEvents' | 'getAppStateVersion'
  >;
  adminSecret: string;
  runBay: RunBay;
  io: WebhookIo;
}

interface SinkCliFlags {
  secretStdout?: boolean;
  vault?: string;
  vaultEnv: string;
  fleet?: string;
}

interface StateVersionCliFlag {
  stateVersion?: string;
}

interface UpdateCliOpts extends StateVersionCliFlag {
  events: string;
}

type RotateCliOpts = SinkCliFlags & StateVersionCliFlag;

const STATE_VERSION_OPTION_DESCRIPTION =
  'Refuse (exit 30) unless the app is still at this state version, for example the one `manifest plan` printed';

interface CreateCliOpts extends SinkCliFlags {
  url: string;
  events: string;
}

export function createWebhookIo(): WebhookIo {
  return {
    log: (text) => {
      process.stdout.write(`${text}\n`);
    },
    writeStdout: (text) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
      }),
    writeStderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
  };
}

function addSinkOptions(command: Command): Command {
  return command
    .option('--secret-stdout', 'Write only the signing secret to stdout (capture it with $(...))')
    .option('--vault <name>', 'Store the signing secret in the Bay vault under this name')
    .option('--vault-env <env>', 'Bay vault environment for --vault', DEFAULT_VAULT_ENV)
    .option('--fleet <path>', 'Bay fleet directory for --vault (default: $PIGEON_BAY_FLEET)');
}

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program.command('webhooks').description('Manage tenant webhooks (admin)');

  webhooks
    .command('list <appId>')
    .description('List the webhooks of an app')
    .action(async (appId: string, _cliOpts: unknown, command: Command) => {
      await listWebhooksCommand({
        appId,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });

  addSinkOptions(
    webhooks
      .command('create <appId>')
      .description('Create a webhook. The signing secret is shown once, so pass a secret sink')
      .requiredOption('--url <url>', 'Endpoint that receives the events')
      .requiredOption(
        '--events <list>',
        `Comma separated event types: ${WEBHOOK_EVENT_TYPES.join(', ')}, or *`,
      ),
  ).action(async (appId: string, cliOpts: CreateCliOpts, command: Command) => {
    await createWebhookCommand({
      appId,
      url: cliOpts.url,
      events: cliOpts.events,
      sinkOpts: cliOpts,
      isJson: command.optsWithGlobals<GlobalOpts>().json,
      isStdoutTty: process.stdout.isTTY === true,
      deps: buildDeps(),
    });
  });

  webhooks
    .command('update <appId> <webhookId>')
    .description('Replace the event types of a webhook. The signing secret stays the same')
    .requiredOption(
      '--events <list>',
      `Comma separated event types: ${WEBHOOK_EVENT_TYPES.join(', ')}, or *`,
    )
    .option('--state-version <n>', STATE_VERSION_OPTION_DESCRIPTION)
    .action(async (appId: string, webhookId: string, cliOpts: UpdateCliOpts, command: Command) => {
      await updateWebhookCommand({
        appId,
        webhookId,
        events: cliOpts.events,
        pinnedVersion: parsePinnedVersion(cliOpts.stateVersion),
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });

  addSinkOptions(
    webhooks
      .command('rotate <appId> <webhookId>')
      .description('Rotate the signing secret of a webhook. The old secret stops working')
      .option('--state-version <n>', STATE_VERSION_OPTION_DESCRIPTION),
  ).action(async (appId: string, webhookId: string, cliOpts: RotateCliOpts, command: Command) => {
    await rotateWebhookCommand({
      appId,
      webhookId,
      sinkOpts: cliOpts,
      pinnedVersion: parsePinnedVersion(cliOpts.stateVersion),
      isJson: command.optsWithGlobals<GlobalOpts>().json,
      isStdoutTty: process.stdout.isTTY === true,
      deps: buildDeps(),
    });
  });
}

function parsePinnedVersion(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : parseStateVersionOption(raw);
}

/**
 * The version a guarded write sends as If-Match: read fresh from the server
 * before the write. Refuses with ServerTooOldForGuardedWritesError when the
 * server sends no version, and with StateVersionPinError when `--state-version`
 * names another one. Both refusals come before any write.
 */
async function readGuardVersion(opts: {
  appId: string;
  pinnedVersion: number | undefined;
  deps: WebhookDeps;
}): Promise<number> {
  const { deps } = opts;
  const current = requireStateVersion(
    await deps.client.getAppStateVersion({ adminSecret: deps.adminSecret, appId: opts.appId }),
  );
  assertPinnedStateVersion({ pinned: opts.pinnedVersion, current });
  return current;
}

/** The 412 message of a guarded webhook command: nothing changed, look again, then rerun. */
function conflictFor(opts: { error: StateVersionConflictError; appId: string; what: string }): StateVersionConflictError {
  const { error, appId } = opts;
  return new StateVersionConflictError({
    expected: error.expected,
    current: error.current,
    message:
      `The app changed while this command ran (state version ${error.expected} expected, ${error.current} now). ` +
      `${opts.what} Check \`pigeon webhooks list ${appId}\`, then run the command again.`,
  });
}

function buildDeps(): WebhookDeps {
  return {
    client: new PigeonClient(),
    adminSecret: getAdminSecret(),
    runBay: createRunBay(),
    io: createWebhookIo(),
  };
}

function formatTime(value: string | null): string {
  return value ?? '-';
}

function formatEnabled(value: boolean | null): string {
  if (value === null) return '-';
  return value ? 'yes' : 'no';
}

export async function listWebhooksCommand(opts: {
  appId: string;
  isJson: boolean;
  deps: WebhookDeps;
}): Promise<void> {
  const { deps } = opts;
  const { webhooks } = await deps.client.listWebhooks({
    adminSecret: deps.adminSecret,
    appId: opts.appId,
  });

  if (opts.isJson) {
    deps.io.log(JSON.stringify(webhooks, null, 2));
    return;
  }

  if (webhooks.length === 0) {
    deps.io.log('No webhooks found.');
    return;
  }

  const rows = webhooks.map((hook) => [
    hook.id,
    hook.url,
    hook.eventTypes?.join(',') ?? '-',
    formatEnabled(hook.enabled),
    formatTime(hook.lastSuccessAt),
    formatTime(hook.lastFailureAt),
  ]);
  deps.io.log(
    formatTable(['ID', 'URL', 'Events', 'Enabled', 'Last success', 'Last failure'], rows),
  );
}

export async function updateWebhookCommand(opts: {
  appId: string;
  webhookId: string;
  events: string;
  pinnedVersion?: number;
  isJson: boolean;
  deps: WebhookDeps;
}): Promise<void> {
  const { deps } = opts;
  const eventTypes = parseEventTypes(opts.events);
  const expectedVersion = await readGuardVersion({ appId: opts.appId, pinnedVersion: opts.pinnedVersion, deps });

  let webhook: PigeonWebhook;
  try {
    ({ webhook } = await deps.client.updateWebhookEvents({
      adminSecret: deps.adminSecret,
      appId: opts.appId,
      webhookId: opts.webhookId,
      eventTypes,
      expectedVersion,
    }));
  } catch (error) {
    if (!(error instanceof StateVersionConflictError)) throw error;
    throw conflictFor({ error, appId: opts.appId, what: 'The event list was not changed.' });
  }

  if (opts.isJson) {
    deps.io.log(JSON.stringify(webhook, null, 2));
    return;
  }
  deps.io.log(`Webhook ${webhook.id} now receives: ${webhook.eventTypes?.join(', ') ?? '-'}`);
}

function assertValidUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error(`--url is not a valid URL: ${url}`);
  }
}

/** Resolves the sink, then checks the vault, all before any API call. */
async function prepareSink(opts: {
  action: SecretAction;
  sinkOpts: SinkCliFlags;
  isJson: boolean;
  isStdoutTty: boolean;
  deps: WebhookDeps;
}): Promise<SecretSink> {
  const sinkCliOpts: SecretSinkCliOpts = opts.sinkOpts;
  const sink = resolveSecretSink({
    cliOpts: sinkCliOpts,
    isJson: opts.isJson,
    isStdoutTty: opts.isStdoutTty,
  });
  if (sink.kind === 'vault') {
    await preflightVault({
      runBay: opts.deps.runBay,
      target: sink.target,
      allowExisting: opts.action === 'rotate',
    });
  }
  return sink;
}

/** Keeps a clear 4xx as it is. Adds a hint when the server may have acted anyway. */
function withOutcomeHint(opts: { error: unknown; hint: string }): Error {
  const { error } = opts;
  if (error instanceof PigeonHttpError && error.status < 500) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n${opts.hint}`);
}

export async function createWebhookCommand(opts: {
  appId: string;
  url: string;
  events: string;
  sinkOpts: SinkCliFlags;
  isJson: boolean;
  isStdoutTty: boolean;
  deps: WebhookDeps;
}): Promise<void> {
  const { deps, appId } = opts;
  const eventTypes = parseEventTypes(opts.events);
  assertValidUrl(opts.url);
  const sink = await prepareSink({ ...opts, action: 'create' });

  let created: PigeonWebhookWithSecret;
  try {
    created = await deps.client.createWebhook({
      adminSecret: deps.adminSecret,
      appId,
      url: opts.url,
      eventTypes,
    });
  } catch (error) {
    if (error instanceof WebhookExistsError) {
      throw new Error(
        `Webhook ${error.webhookId} already exists for app ${appId}. ` +
          `Use \`pigeon webhooks rotate ${appId} ${error.webhookId} ${describeSinkFlags(sink)}\` ` +
          'only if you mean to replace its secret.',
      );
    }
    throw withOutcomeHint({
      error,
      hint: `The webhook may have been created. Run \`pigeon webhooks list ${appId}\` to check.`,
    });
  }

  await deliverSecret({ action: 'create', appId, result: created, sink, isJson: opts.isJson, deps });
}

export async function rotateWebhookCommand(opts: {
  appId: string;
  webhookId: string;
  sinkOpts: SinkCliFlags;
  pinnedVersion?: number;
  isJson: boolean;
  isStdoutTty: boolean;
  deps: WebhookDeps;
}): Promise<void> {
  const { deps, appId, webhookId } = opts;
  const sink = await prepareSink({ ...opts, action: 'rotate' });
  const expectedVersion = await readGuardVersion({ appId, pinnedVersion: opts.pinnedVersion, deps });

  let rotated: PigeonWebhookWithSecret;
  try {
    rotated = await deps.client.rotateWebhookSecret({
      adminSecret: deps.adminSecret,
      appId,
      webhookId,
      expectedVersion,
    });
  } catch (error) {
    if (error instanceof StateVersionConflictError) {
      throw conflictFor({ error, appId, what: 'The secret was not rotated; the old one still works.' });
    }
    throw withOutcomeHint({
      error,
      hint:
        'The secret may have been rotated. Run the same command again to get a working secret: ' +
        `pigeon webhooks rotate ${appId} ${webhookId} ${describeSinkFlags(sink)}`,
    });
  }

  await deliverSecret({ action: 'rotate', appId, result: rotated, sink, isJson: opts.isJson, deps });
}

function redactSecret(opts: { text: string; secret: string }): string {
  return opts.text.split(opts.secret).join('<redacted>');
}

/** Sends the secret to its sink. A failure throws a message with the id and the recovery command. */
async function writeSecretToSink(opts: {
  action: SecretAction;
  appId: string;
  result: PigeonWebhookWithSecret;
  sink: SecretSink;
  deps: WebhookDeps;
}): Promise<void> {
  const { sink, deps } = opts;
  const { webhook, signingSecret } = opts.result;

  try {
    if (sink.kind === 'stdout') {
      await deps.io.writeStdout(`${signingSecret}\n`);
      return;
    }
    await storeVaultSecret({ runBay: deps.runBay, target: sink.target, value: signingSecret });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const destination = sink.kind === 'stdout' ? 'written to stdout' : 'stored in the Bay vault';
    const done = opts.action === 'create' ? 'created' : 'rotated';
    throw new Error(
      redactSecret({
        text:
          `Webhook ${webhook.id} was ${done}, but the secret could not be ${destination}. ${reason}\n` +
          'The secret was not shown and is lost. Mint a new one with:\n' +
          `pigeon webhooks rotate ${opts.appId} ${webhook.id} ${describeSinkFlags(sink)}`,
        secret: signingSecret,
      }),
    );
  }
}

async function deliverSecret(opts: {
  action: SecretAction;
  appId: string;
  result: PigeonWebhookWithSecret;
  sink: SecretSink;
  isJson: boolean;
  deps: WebhookDeps;
}): Promise<void> {
  const { sink, deps } = opts;
  const { webhook, signingSecret } = opts.result;

  await writeSecretToSink(opts);

  const secretLine =
    sink.kind === 'stdout'
      ? `secret: emitted to stdout (${signingSecret.length} chars)`
      : 'secret: stored in vault';
  printSummary({ webhook, secretLine, writeStderr: deps.io.writeStderr });

  if (sink.kind === 'stdout') return;

  const vault = { name: sink.target.name, env: sink.target.env, stored: true };
  if (opts.isJson) {
    deps.io.log(JSON.stringify({ webhook, vault }, null, 2));
    return;
  }
  const done = opts.action === 'create' ? 'created' : 'rotated';
  deps.io.log(
    `Webhook ${webhook.id} ${done}. Secret stored as ${vault.name} (${vault.env}); the secret is not shown.`,
  );
}

function printSummary(opts: {
  webhook: PigeonWebhook;
  secretLine: string;
  writeStderr: (text: string) => void;
}): void {
  const { webhook } = opts;
  opts.writeStderr(`webhook: ${webhook.id}`);
  opts.writeStderr(`url: ${webhook.url}`);
  opts.writeStderr(`events: ${webhook.eventTypes?.join(', ') ?? '-'}`);
  opts.writeStderr(opts.secretLine);
}
