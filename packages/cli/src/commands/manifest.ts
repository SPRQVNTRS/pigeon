import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { PigeonClient, PigeonHttpError, WebhookExistsError, isMissingRouteError } from '../lib/pigeon-client.js';
import { findTenantKey, getAdminSecret } from '../lib/config.js';
import { resolveFromInvocationDir } from '../lib/invocation.js';
import { createUniqueApp } from '../lib/apps.js';
import { createRunBay, preflightVault, redactTenantKeys, storeVaultSecret } from '../lib/bay-vault.js';
import type { RunBay, VaultTarget } from '../lib/bay-vault.js';
import { formatDnsRecordsTable } from '../lib/domain-output.js';
import { formatTable } from '../lib/formatters.js';
import { describeMailRouting, detectMailRouting } from '../lib/mail-routing.js';
import type { MailRouting } from '../lib/mail-routing.js';
import { formatManifestIssues, parseManifest } from '../lib/manifest.js';
import type { Manifest } from '../lib/manifest.js';
import type { PigeonAudience, PigeonDomain, PigeonWebhookWithSecret } from '../lib/types.js';
import {
  EXIT_CHANGES_NEEDED,
  EXIT_ERROR,
  EXIT_NOT_CHECKED,
  EXIT_OK,
  buildPlan,
  isExecutable,
  isTenantKeyOwnedByApp,
  needsTenantKeyForWrites,
  notCheckedSections,
  parseOrigin,
  planActions,
  planExitCode,
} from '../lib/manifest-plan.js';
import type {
  ExecutableAction,
  LiveApp,
  LiveAudience,
  LiveDomain,
  LiveState,
  ManifestAction,
  Observed,
  Plan,
  WriteKeyStatus,
} from '../lib/manifest-plan.js';
import { DEFAULT_VAULT_ENV, describeSinkFlags, resolveSecretSink } from '../lib/secret-sink.js';
import {
  EXIT_STATE_CONFLICT,
  SERVER_TOO_OLD_MESSAGE,
  StateVersionConflictError,
  describeStateVersion,
  parseStateVersionOption,
  requireStateVersion,
  stateVersionValue,
  summarizeStateVersions,
} from '../lib/state-version.js';
import type { StateVersionReading } from '../lib/state-version.js';
import type { SecretSink } from '../lib/secret-sink.js';
import type { GlobalOpts } from './status.js';

/**
 * `pigeon manifest validate|plan|apply`: the I/O shell around lib/manifest.ts
 * (parse) and lib/manifest-plan.ts (status logic). Reads the file, fetches
 * live state, renders, and runs the additive actions one at a time.
 */

const DEFAULT_MANIFEST_PATH = './pigeon.toml';
const PRODUCTION_KEY_NAME = 'production';
const PLAN_KEY_OPTION_DESCRIPTION =
  'Tenant API key (ske_...), read only when the server has no admin domain and audience lists; falls back to PIGEON_TENANT_KEY';
const APPLY_KEY_OPTION_DESCRIPTION =
  'Tenant API key (ske_...) of the app, needed to register a domain or create an audience; falls back to PIGEON_TENANT_KEY';
const ORIGIN_OPTION_DESCRIPTION = 'Origin of the app (https://host). Webhooks then match the full URL';

export interface ManifestIo {
  log: (text: string) => void;
  writeStderr: (text: string) => void;
}

export type ManifestClient = Pick<
  PigeonClient,
  | 'listApps'
  | 'createApp'
  | 'createApiKey'
  | 'listApiKeys'
  | 'listDomains'
  | 'listAppDomains'
  | 'registerDomain'
  | 'listAudiences'
  | 'listAppAudiences'
  | 'createAudience'
  | 'listWebhooks'
  | 'createWebhook'
  | 'updateWebhookEvents'
  | 'listInboundDomains'
  | 'addInboundDomain'
>;

export interface ManifestDeps {
  client: ManifestClient;
  adminSecret: string;
  runBay: RunBay;
  io: ManifestIo;
  detectMailRouting: (opts: { domain: string; assumeGoogleWorkspace: boolean }) => Promise<MailRouting>;
}

export interface ManifestSource {
  path: string;
  text: string;
}

export interface VaultCliOpts {
  vault: boolean;
  vaultPrefix?: string;
  vaultEnv: string;
  fleet?: string;
}

interface PlanCliOpts {
  key?: string;
  origin?: string;
}

interface ApplyCliOpts extends PlanCliOpts, VaultCliOpts {
  yes: boolean;
  stateVersion?: string;
}

/** The vault settings for every secret this run may mint. Null without --vault. */
interface VaultConfig {
  prefix: string;
  env: string;
  fleet: string | undefined;
}

/** Where each new secret goes. A null API key target means: print it, as onboard does. */
interface SecretTargets {
  apiKey: SecretSink | null;
  webhooks: Map<string, SecretSink>;
}

interface ExecutionState {
  appId: string | null;
  tenantKey: string | null;
  /**
   * The app's state version this run holds. Each guarded write sends it as
   * If-Match and replaces it with the version the write returns. Null until
   * known: a new app gets it from its create answer.
   */
  stateVersion: number | null;
}

interface StepOutput {
  lines: string[];
  json: Record<string, unknown>;
  /** Set when the step failed after it already did something worth reporting. */
  failure: string | null;
  /** Set when the server refused the step with 412: the app changed underneath. */
  conflict: StateVersionConflictError | null;
}

interface StepRecord {
  action: ExecutableAction;
  outcome: 'done' | 'failed' | 'not-run';
  json: Record<string, unknown>;
  error: string | null;
  conflict: StateVersionConflictError | null;
}

/** The live state plus the app's state version read with it. */
export interface ObservedInstance extends LiveState {
  stateVersion: StateVersionReading;
}

/** The state versions of the configuration reads of one observation, in any order. */
type VersionLog = Array<number | null>;

interface SectionRead<T> {
  items: T[];
  stateVersion: number | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function createManifestIo(): ManifestIo {
  return {
    log: (text) => {
      process.stdout.write(`${text}\n`);
    },
    writeStderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
  };
}

function buildDeps(): ManifestDeps {
  return {
    client: new PigeonClient(),
    adminSecret: getAdminSecret(),
    runBay: createRunBay(),
    io: createManifestIo(),
    detectMailRouting,
  };
}

export function readManifestSource(path: string | undefined): ManifestSource {
  const shown = path ?? DEFAULT_MANIFEST_PATH;
  const resolved = resolveFromInvocationDir(shown);
  try {
    return { path: shown, text: readFileSync(resolved, 'utf8') };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the manifest at ${resolved}. ${reason}`);
  }
}

export function registerManifestCommand(program: Command): void {
  const manifest = program
    .command('manifest')
    .description('Check a pigeon.toml manifest against an instance, and add what is missing');

  manifest
    .command('validate [path]')
    .description(`Check a manifest offline (default ${DEFAULT_MANIFEST_PATH}). Exit 0 valid, 1 invalid`)
    .action((path: string | undefined, _cliOpts: unknown, command: Command) => {
      process.exitCode = validateManifestCommand({
        source: readManifestSource(path),
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        io: createManifestIo(),
      });
    });

  manifest
    .command('plan [path]')
    .description('Compare a manifest with the instance. Read only. Exit 0 in sync, 10 changes, 20 not checked')
    .option('--key <apiKey>', PLAN_KEY_OPTION_DESCRIPTION)
    .option('--origin <origin>', ORIGIN_OPTION_DESCRIPTION)
    .action(async (path: string | undefined, cliOpts: PlanCliOpts, command: Command) => {
      process.exitCode = await planManifestCommand({
        source: readManifestSource(path),
        tenantKey: findTenantKey(cliOpts.key),
        origin: cliOpts.origin,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });

  manifest
    .command('apply [path]')
    .description('Add what the manifest declares and the instance lacks. Without --yes it changes nothing')
    .option('--key <apiKey>', APPLY_KEY_OPTION_DESCRIPTION)
    .option('--origin <origin>', ORIGIN_OPTION_DESCRIPTION)
    .option('--yes', 'Perform the actions. Without it, print them and exit 10', false)
    .option('--vault', 'Store new secrets in the Bay vault under the manifest env names, never print them', false)
    .option('--vault-prefix <prefix>', 'Prefix for the vault names, for example MYAPP_ (needs --vault)')
    .option('--vault-env <env>', 'Bay vault environment for --vault', DEFAULT_VAULT_ENV)
    .option('--fleet <path>', 'Bay fleet directory for --vault (default: $PIGEON_BAY_FLEET)')
    .option(
      '--state-version <n>',
      'Refuse before any write (exit 30) unless the app is still at this state version, the one plan printed',
    )
    .action(async (path: string | undefined, cliOpts: ApplyCliOpts, command: Command) => {
      process.exitCode = await applyManifestCommand({
        source: readManifestSource(path),
        tenantKey: findTenantKey(cliOpts.key),
        origin: cliOpts.origin,
        isYes: cliOpts.yes,
        pinnedVersion: cliOpts.stateVersion === undefined ? undefined : parseStateVersionOption(cliOpts.stateVersion),
        vaultOpts: cliOpts,
        isJson: command.optsWithGlobals<GlobalOpts>().json,
        deps: buildDeps(),
      });
    });
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function loadManifest(opts: { source: ManifestSource; isJson: boolean; io: ManifestIo }): Manifest | null {
  const result = parseManifest(opts.source.text);
  if (result.ok) return result.manifest;

  if (opts.isJson) {
    opts.io.log(JSON.stringify({ path: opts.source.path, valid: false, issues: result.issues }, null, 2));
    return null;
  }
  opts.io.writeStderr(`${opts.source.path} is not valid (${result.issues.length} issue(s)):`);
  opts.io.writeStderr(formatManifestIssues(result.issues));
  return null;
}

export function validateManifestCommand(opts: { source: ManifestSource; isJson: boolean; io: ManifestIo }): number {
  const manifest = loadManifest(opts);
  if (manifest === null) return EXIT_ERROR;

  if (opts.isJson) {
    opts.io.log(JSON.stringify({ path: opts.source.path, valid: true, manifest }, null, 2));
    return EXIT_OK;
  }
  opts.io.log(
    `${opts.source.path} is valid: app "${manifest.app}", ${manifest.domains.length} domain(s), ` +
      `${manifest.senders.length} sender(s), ${manifest.audiences.length} audience(s), ` +
      `${manifest.webhooks.length} webhook(s), ${manifest.inbound.length} inbound domain(s).`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactTenantKeys(message);
}

async function observe<T>(read: () => Promise<T[]>): Promise<Observed<T>> {
  try {
    return { kind: 'read', items: await read() };
  } catch (error) {
    return { kind: 'not-checked', reason: `request failed: ${errorMessage(error)}` };
  }
}

/** A configuration read: its items, and the app's state version on that answer goes to the log. */
function observeVersioned<T>(opts: { read: () => Promise<SectionRead<T>>; versions: VersionLog }): Promise<Observed<T>> {
  return observe(async () => {
    const { items, stateVersion } = await opts.read();
    opts.versions.push(stateVersion);
    return items;
  });
}

function unreadable(opts: { app: LiveApp; reason: string }): ObservedInstance {
  const notChecked = { kind: 'not-checked', reason: opts.reason } as const;
  return {
    app: opts.app,
    domains: notChecked,
    audiences: notChecked,
    webhooks: notChecked,
    inboundDomains: notChecked,
    stateVersion: { kind: 'no-app', reason: opts.reason },
  };
}

type TenantAccess = { kind: 'usable'; tenantKey: string } | { kind: 'unusable'; reason: string };

/**
 * Whether a tenant key may be used for this app: it must be an active key of
 * the app, or a request with it would read or write another app.
 */
async function checkTenantKey(opts: {
  appId: string;
  tenantKey: string | null;
  deps: ManifestDeps;
}): Promise<TenantAccess> {
  const { deps, tenantKey } = opts;
  if (tenantKey === null) return { kind: 'unusable', reason: 'no tenant key. Pass --key <ske_...> or set PIGEON_TENANT_KEY' };

  const keys = await observe(async () => {
    const { apiKeys } = await deps.client.listApiKeys({ adminSecret: deps.adminSecret, appId: opts.appId });
    return apiKeys;
  });
  if (keys.kind === 'not-checked') return { kind: 'unusable', reason: `could not check the tenant key: ${keys.reason}` };
  if (!isTenantKeyOwnedByApp({ tenantKey, appKeys: keys.items })) {
    return { kind: 'unusable', reason: `the tenant key is not an active key of app ${opts.appId}` };
  }
  return { kind: 'usable', tenantKey };
}

/** Runs the key check at most once per observation, and only when a section needs it. */
function lazyTenantKeyCheck(opts: {
  appId: string;
  tenantKey: string | null;
  deps: ManifestDeps;
}): () => Promise<TenantAccess> {
  let pending: Promise<TenantAccess> | null = null;
  return () => {
    pending ??= checkTenantKey(opts);
    return pending;
  };
}

/**
 * One section of the live state. Reads it with the admin secret. Only a server
 * without the admin route (see isMissingRouteError) falls back to the tenant key.
 * Any other failure leaves the section not-checked: it is never read as empty.
 */
async function observeSection<T>(opts: {
  readWithAdminSecret: () => Promise<SectionRead<T>>;
  readWithTenantKey: (tenantKey: string) => Promise<SectionRead<T>>;
  checkTenantKey: () => Promise<TenantAccess>;
  versions: VersionLog;
}): Promise<Observed<T>> {
  try {
    const { items, stateVersion } = await opts.readWithAdminSecret();
    opts.versions.push(stateVersion);
    return { kind: 'read', items };
  } catch (error) {
    if (!isMissingRouteError(error)) return { kind: 'not-checked', reason: `request failed: ${errorMessage(error)}` };
  }

  const access = await opts.checkTenantKey();
  if (access.kind === 'unusable') {
    return { kind: 'not-checked', reason: `this server has no admin list for it, and ${access.reason}` };
  }
  return observeVersioned({ read: () => opts.readWithTenantKey(access.tenantKey), versions: opts.versions });
}

async function observeDomainsAndAudiences(opts: {
  appId: string;
  tenantKey: string | null;
  deps: ManifestDeps;
  versions: VersionLog;
}): Promise<Pick<LiveState, 'domains' | 'audiences'>> {
  const { appId, deps, versions } = opts;
  const { adminSecret } = deps;
  const checkKey = lazyTenantKeyCheck(opts);

  const [domains, audiences] = await Promise.all([
    observeSection({
      readWithAdminSecret: async () => toDomainRead(await deps.client.listAppDomains({ adminSecret, appId })),
      readWithTenantKey: async (tenantKey) => toDomainRead(await deps.client.listDomains({ tenantKey })),
      checkTenantKey: checkKey,
      versions,
    }),
    observeSection({
      readWithAdminSecret: async () => toAudienceRead(await deps.client.listAppAudiences({ adminSecret, appId })),
      readWithTenantKey: async (tenantKey) => toAudienceRead(await deps.client.listAudiences({ tenantKey })),
      checkTenantKey: checkKey,
      versions,
    }),
  ]);
  return { domains, audiences };
}

function toDomainRead(result: { domains: PigeonDomain[]; stateVersion: number | null }): SectionRead<LiveDomain> {
  return { items: toLiveDomains(result.domains), stateVersion: result.stateVersion };
}

function toAudienceRead(result: { audiences: PigeonAudience[]; stateVersion: number | null }): SectionRead<LiveAudience> {
  return { items: toLiveAudiences(result.audiences), stateVersion: result.stateVersion };
}

function toLiveDomains(domains: PigeonDomain[]): LiveDomain[] {
  return domains.map((domain) => ({ id: domain.id, name: domain.name, isVerified: domain.dkimStatus === 'verified' }));
}

function toLiveAudiences(audiences: PigeonAudience[]): LiveAudience[] {
  return audiences.map((audience) => ({ id: audience.id, name: audience.name }));
}

/**
 * Reads what the instance has, and the app's state version with it (the lowest
 * version any read reported, see summarizeStateVersions). Throws only when the
 * app list itself cannot be read.
 */
export async function observeLiveState(opts: {
  manifest: Manifest;
  tenantKey: string | null;
  deps: ManifestDeps;
}): Promise<ObservedInstance> {
  const { deps, manifest } = opts;
  const { apps } = await deps.client.listApps({ adminSecret: deps.adminSecret });
  const matches = apps.filter((app) => app.name === manifest.app);

  const [first, ...others] = matches;
  if (first === undefined) {
    return unreadable({ app: { kind: 'missing' }, reason: `app "${manifest.app}" does not exist on this instance` });
  }
  if (others.length > 0) {
    return unreadable({
      app: { kind: 'ambiguous', ids: matches.map((app) => app.id) },
      reason: `${matches.length} apps are named "${manifest.app}"`,
    });
  }

  const appId = first.id;
  const versions: VersionLog = [];
  const [webhooks, inboundDomains, tenantSections] = await Promise.all([
    observeVersioned({
      read: async () => {
        const result = await deps.client.listWebhooks({ adminSecret: deps.adminSecret, appId });
        const items = result.webhooks.map((hook) => ({
          id: hook.id,
          url: hook.url,
          eventTypes: hook.eventTypes ?? ['*'],
          enabled: hook.enabled ?? true,
        }));
        return { items, stateVersion: result.stateVersion };
      },
      versions,
    }),
    observeVersioned({
      read: async () => {
        const result = await deps.client.listInboundDomains({ adminSecret: deps.adminSecret, appId });
        const items = result.inboundDomains.map((domain) => ({ id: domain.id, name: domain.name, enabled: domain.enabled }));
        return { items, stateVersion: result.stateVersion };
      },
      versions,
    }),
    observeDomainsAndAudiences({ appId, tenantKey: opts.tenantKey, deps, versions }),
  ]);

  return {
    app: { kind: 'found', id: appId },
    webhooks,
    inboundDomains,
    ...tenantSections,
    stateVersion: summarizeStateVersions(versions),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface PlanDisplayRow {
  section: string;
  item: string;
  status: string;
  env: string[];
  detail: string;
}

function notCheckedDetail(reason: string | null): string {
  return `not checked: ${reason ?? 'unknown reason'}`;
}

function appDetail(plan: Plan): string {
  const { app } = plan;
  switch (app.status) {
    case 'ok':
      return `id ${app.id ?? '-'}`;
    case 'missing':
      return 'not found on this instance';
    case 'ambiguous':
      return `${app.duplicateIds.length} apps share this name: ${app.duplicateIds.join(', ')}`;
    default: {
      const unreachable: never = app.status;
      throw new Error(`Unknown app status: ${String(unreachable)}`);
    }
  }
}

function enabledNote(isEnabled: boolean | null): string {
  return isEnabled === false ? ', disabled' : '';
}

/** One row per declared item, in manifest order. Env columns hold names only. */
export function planDisplayRows(opts: { plan: Plan; manifest: Manifest }): PlanDisplayRow[] {
  const { plan, manifest } = opts;
  const rows: PlanDisplayRow[] = [
    {
      section: 'app',
      item: plan.app.name,
      status: plan.app.status,
      env: [manifest.env.apiKey, manifest.env.baseUrl],
      detail: appDetail(plan),
    },
  ];

  for (const row of plan.domains.rows) {
    const detailByStatus = {
      ok: `id ${row.liveId ?? '-'}, DKIM verified`,
      unverified: `id ${row.liveId ?? '-'}, DKIM not verified yet`,
      missing: 'not registered',
      'not-checked': notCheckedDetail(plan.domains.notCheckedReason),
    } as const;
    rows.push({ section: 'domain', item: row.declared.name, status: row.status, env: [], detail: detailByStatus[row.status] });
  }

  for (const row of plan.senders) {
    const domain = row.declared.address.slice(row.declared.address.lastIndexOf('@') + 1);
    rows.push({
      section: 'sender',
      item: row.declared.address,
      status: row.status,
      env: row.declared.env === null ? [] : [row.declared.env],
      detail: `domain ${domain} is ${row.domainStatus}`,
    });
  }

  for (const row of plan.audiences.rows) {
    const detailByStatus = {
      ok: `id ${row.liveId ?? '-'}`,
      missing: 'not created',
      'not-checked': notCheckedDetail(plan.audiences.notCheckedReason),
    } as const;
    rows.push({
      section: 'audience',
      item: row.declared.name,
      status: row.status,
      env: row.declared.idEnv === null ? [] : [row.declared.idEnv],
      detail: detailByStatus[row.status],
    });
  }

  for (const row of plan.webhooks.rows) {
    const match = row.matches[0];
    const where = plan.origin === null ? 'this path' : `${plan.origin}${row.declared.path}`;
    const detailByStatus = {
      ok: `id ${match?.id ?? '-'}, ${match?.url ?? '-'}${enabledNote(match?.enabled ?? null)}`,
      'events-differ': `id ${row.matches.map((hook) => hook.id).join(', ')} lacks ${row.missingEvents.join(', ')}`,
      missing: `no webhook at ${where}`,
      'not-checked': notCheckedDetail(plan.webhooks.notCheckedReason),
    } as const;
    rows.push({
      section: 'webhook',
      item: row.declared.path,
      status: row.status,
      env: [row.declared.secretEnv],
      detail: detailByStatus[row.status],
    });
  }

  for (const row of plan.inbound.rows) {
    const detailByStatus = {
      ok: `id ${row.liveId ?? '-'}${enabledNote(row.isEnabled)}`,
      missing: 'not registered',
      'not-checked': notCheckedDetail(plan.inbound.notCheckedReason),
    } as const;
    rows.push({
      section: 'inbound',
      item: row.declared.domain,
      status: row.status,
      env: row.declared.env === null ? [] : [row.declared.env],
      detail: detailByStatus[row.status],
    });
  }
  return rows;
}

function undeclaredRows(plan: Plan): Array<{ section: string; item: string; id: string }> {
  return [
    ...plan.domains.undeclared.map((item) => ({ section: 'domain', item: item.name, id: item.id })),
    ...plan.audiences.undeclared.map((item) => ({ section: 'audience', item: item.name, id: item.id })),
    ...plan.webhooks.undeclared.map((item) => ({ section: 'webhook', item: item.name, id: item.id })),
    ...plan.inbound.undeclared.map((item) => ({ section: 'inbound', item: item.name, id: item.id })),
  ];
}

function describeExitCode(code: number): string {
  if (code === EXIT_OK) return 'everything declared is ok';
  if (code === EXIT_CHANGES_NEEDED) return 'changes needed';
  if (code === EXIT_NOT_CHECKED) return 'at least one section was not checked';
  return 'error';
}

function planJson(opts: {
  plan: Plan;
  manifest: Manifest;
  path: string;
  stateVersion: StateVersionReading;
}): Record<string, unknown> {
  const { plan } = opts;
  const exitCode = planExitCode(plan);
  return {
    path: opts.path,
    app: opts.manifest.app,
    origin: plan.origin,
    stateVersion: stateVersionValue(opts.stateVersion),
    stateVersionNote: describeStateVersion(opts.stateVersion),
    rows: planDisplayRows(opts),
    undeclared: undeclaredRows(plan),
    notChecked: notCheckedSections(plan),
    exitCode,
    result: describeExitCode(exitCode),
  };
}

function renderPlanText(opts: {
  plan: Plan;
  manifest: Manifest;
  path: string;
  stateVersion: StateVersionReading;
  io: ManifestIo;
}): void {
  const { plan, manifest, io } = opts;
  io.log(`Manifest: ${opts.path}  app: ${manifest.app}  origin: ${plan.origin ?? '(none, webhooks match by path)'}`);
  io.log(`Env names: API key in ${manifest.env.apiKey}, base URL in ${manifest.env.baseUrl}`);
  io.log(describeStateVersion(opts.stateVersion));
  io.log('');

  const rows = planDisplayRows({ plan, manifest }).map((row) => [
    row.section,
    row.item,
    row.status,
    row.env.join(', ') || '-',
    row.detail,
  ]);
  io.log(formatTable(['Section', 'Item', 'Status', 'Env', 'Detail'], rows));

  const undeclared = undeclaredRows(plan);
  if (undeclared.length > 0) {
    io.log('');
    io.log('Undeclared on the instance (information only, never changed):');
    io.log(formatTable(['Section', 'Item', 'ID'], undeclared.map((row) => [row.section, row.item, row.id])));
  }

  const notChecked = notCheckedSections(plan);
  if (notChecked.length > 0) {
    io.log('');
    io.log('Not checked (the state of these sections is unknown):');
    for (const section of notChecked) io.log(`  ${section.section}: ${section.reason}`);
  }

  const code = planExitCode(plan);
  io.log('');
  io.log(`Result: ${describeExitCode(code)} (exit ${code}).`);
}

function renderPlan(opts: {
  plan: Plan;
  manifest: Manifest;
  path: string;
  stateVersion: StateVersionReading;
  isJson: boolean;
  io: ManifestIo;
}): void {
  if (opts.isJson) {
    opts.io.log(JSON.stringify(planJson(opts), null, 2));
    return;
  }
  renderPlanText(opts);
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export async function planManifestCommand(opts: {
  source: ManifestSource;
  tenantKey: string | null;
  origin: string | undefined;
  isJson: boolean;
  deps: ManifestDeps;
}): Promise<number> {
  const { deps } = opts;
  const manifest = loadManifest({ source: opts.source, isJson: opts.isJson, io: deps.io });
  if (manifest === null) return EXIT_ERROR;
  const origin = opts.origin === undefined ? null : parseOrigin(opts.origin);

  const live = await observeLiveState({ manifest, tenantKey: opts.tenantKey, deps });
  const plan = buildPlan({ manifest, live, origin });
  renderPlan({ plan, manifest, path: opts.source.path, stateVersion: live.stateVersion, isJson: opts.isJson, io: deps.io });
  return planExitCode(plan);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function resolveVaultConfig(opts: VaultCliOpts): VaultConfig | null {
  if (opts.vault) return { prefix: opts.vaultPrefix ?? '', env: opts.vaultEnv, fleet: opts.fleet };
  if (opts.vaultPrefix !== undefined) throw new Error('--vault-prefix only works with --vault.');
  if (opts.fleet !== undefined) throw new Error('--fleet only works with --vault.');
  if (opts.vaultEnv !== DEFAULT_VAULT_ENV) throw new Error('--vault-env only works with --vault.');
  return null;
}

/** The vault sink for one env name, validated by the shared secret-sink rules. */
function vaultSinkFor(opts: { config: VaultConfig; envName: string }): SecretSink {
  return resolveSecretSink({
    cliOpts: { vault: `${opts.config.prefix}${opts.envName}`, vaultEnv: opts.config.env, fleet: opts.config.fleet },
    isJson: false,
    isStdoutTty: false,
  });
}

/** Resolves and preflights every vault name before the first write, so a refusal changes nothing. */
async function prepareSecretTargets(opts: {
  actions: ExecutableAction[];
  manifest: Manifest;
  config: VaultConfig | null;
  runBay: RunBay;
}): Promise<SecretTargets> {
  const { config } = opts;
  const targets: SecretTargets = { apiKey: null, webhooks: new Map() };
  if (config === null) return targets;

  if (opts.actions.some((action) => action.kind === 'create-app')) {
    targets.apiKey = vaultSinkFor({ config, envName: opts.manifest.env.apiKey });
  }
  for (const action of opts.actions) {
    if (action.kind !== 'create-webhook') continue;
    targets.webhooks.set(action.secretEnv, vaultSinkFor({ config, envName: action.secretEnv }));
  }

  const sinks = [targets.apiKey, ...targets.webhooks.values()].filter((sink): sink is SecretSink => sink !== null);
  for (const sink of sinks) {
    if (sink.kind !== 'vault') continue;
    await preflightVault({ runBay: opts.runBay, target: sink.target });
  }
  return targets;
}

function vaultNameFor(opts: { config: VaultConfig | null; envName: string }): string | null {
  if (opts.config === null) return null;
  return `${opts.config.prefix}${opts.envName}`;
}

function describeAction(opts: { action: ManifestAction; manifest: Manifest; config: VaultConfig | null }): string {
  const { action, manifest, config } = opts;
  switch (action.kind) {
    case 'create-app': {
      const vaultName = vaultNameFor({ config, envName: manifest.env.apiKey });
      const keyGoesTo = vaultName === null ? 'printed once' : `stored in the Bay vault as ${vaultName}`;
      return `create app "${action.name}" with a ${PRODUCTION_KEY_NAME} API key (for ${manifest.env.apiKey}, ${keyGoesTo})`;
    }
    case 'register-domain':
      return `register sending domain ${action.name} and print its DNS records`;
    case 'create-audience':
      return `create audience "${action.name}"${action.idEnv === null ? '' : ` (its id goes in ${action.idEnv})`}`;
    case 'add-inbound-domain':
      return `add inbound domain ${action.name}`;
    case 'create-webhook': {
      const vaultName = vaultNameFor({ config, envName: action.secretEnv }) ?? action.secretEnv;
      return `create webhook ${action.url} for ${action.events.join(', ')} (signing secret for ${action.secretEnv}, stored in the Bay vault as ${vaultName})`;
    }
    case 'update-webhook-events':
      return `add ${action.addedEvents.join(', ')} to webhook ${action.webhookId} (${action.url}); it then receives ${action.events.join(', ')}`;
    case 'blocked':
      return `BLOCKED ${action.section} ${action.item}: ${action.reason}`;
    default: {
      const unreachable: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(unreachable)}`);
    }
  }
}

function keyBlock(plaintext: string): string[] {
  return [
    '',
    '=== STORE THIS KEY NOW, it will not be shown again ===',
    plaintext,
    '========================================================',
    '',
  ];
}

function requireAppId(state: ExecutionState): string {
  if (state.appId === null) throw new Error('No app id. The app step did not run.');
  return state.appId;
}

function requireTenantKey(state: ExecutionState): string {
  if (state.tenantKey === null) throw new Error('No tenant key. Pass --key <ske_...> or set PIGEON_TENANT_KEY.');
  return state.tenantKey;
}

/** The version the next guarded write sends as If-Match. */
function heldStateVersion(state: ExecutionState): number {
  return requireStateVersion(state.stateVersion);
}

/** Takes the version a guarded write returned: the next write must send it. */
function advanceStateVersion(opts: { state: ExecutionState; returned: number | null }): void {
  opts.state.stateVersion = requireStateVersion(opts.returned);
}

function redactSecret(opts: { text: string; secret: string }): string {
  return opts.text.split(opts.secret).join('<redacted>');
}

async function executeCreateApp(opts: {
  action: Extract<ExecutableAction, { kind: 'create-app' }>;
  manifest: Manifest;
  state: ExecutionState;
  targets: SecretTargets;
  deps: ManifestDeps;
  out: StepOutput;
}): Promise<void> {
  const { deps, out, state } = opts;
  const { app, stateVersion } = await createUniqueApp({
    client: deps.client,
    adminSecret: deps.adminSecret,
    name: opts.action.name,
    force: false,
  });
  state.appId = app.id;
  // The create itself is unguarded (there is no app to hold a version yet). Every
  // later write of this run is guarded with the version the new app starts at.
  state.stateVersion = stateVersion;
  out.json.appId = app.id;
  out.lines.push(`Created app "${app.name}" (id: ${app.id})`);

  const { apiKey, plaintext } = await deps.client.createApiKey({
    adminSecret: deps.adminSecret,
    appId: app.id,
    name: PRODUCTION_KEY_NAME,
  });
  state.tenantKey = plaintext;
  out.json.apiKey = { id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, env: opts.manifest.env.apiKey };
  out.lines.push(`Created API key "${apiKey.name}" (prefix: ${apiKey.prefix}) for ${opts.manifest.env.apiKey}`);

  const sink = opts.targets.apiKey;
  if (sink === null || sink.kind !== 'vault') {
    out.json.plaintext = plaintext;
    out.lines.push(...keyBlock(plaintext));
    return;
  }

  try {
    await storeVaultSecret({ runBay: deps.runBay, target: sink.target, value: plaintext });
  } catch (error) {
    // Like onboard: a failed vault write never loses the key, it falls back to printing it.
    out.json.plaintext = plaintext;
    out.lines.push(`Could not store the key in the Bay vault. ${redactSecret({ text: errorMessage(error), secret: plaintext })}`);
    out.lines.push(...keyBlock(plaintext));
    out.failure = 'the API key could not be stored in the Bay vault (it is printed above instead)';
    return;
  }
  out.json.vault = { name: sink.target.name, env: sink.target.env, stored: true };
  out.lines.push(`Stored the key in the Bay vault as ${sink.target.name} (${sink.target.env}). The key is not shown.`);
  out.lines.push(
    `Commit and push only group_vars/${sink.target.env}/secrets.yml in the fleet repo: ` +
      `vault(${sink.target.env}): ${opts.manifest.app} Pigeon API key`,
  );
}

async function executeRegisterDomain(opts: {
  action: Extract<ExecutableAction, { kind: 'register-domain' }>;
  state: ExecutionState;
  deps: ManifestDeps;
  out: StepOutput;
}): Promise<void> {
  const { action, deps, out } = opts;
  const registration = await deps.client.registerDomain({
    tenantKey: requireTenantKey(opts.state),
    domain: action.name,
    expectedVersion: heldStateVersion(opts.state),
  });
  advanceStateVersion({ state: opts.state, returned: registration.stateVersion });
  out.json.domainId = registration.domain.id;
  out.json.dnsRecords = registration.dnsRecords;
  out.lines.push(`Registered domain "${registration.domain.name}" (id: ${registration.domain.id})`);

  let routing: MailRouting;
  try {
    routing = await deps.detectMailRouting({ domain: action.name, assumeGoogleWorkspace: action.receivesMail });
  } catch (error) {
    out.lines.push(`Could not look up the live MX of ${action.name} (${errorMessage(error)}). Records are shown as returned.`);
    routing = { inboundMx: [], provider: null, existingSpf: null };
  }
  out.lines.push(`DNS records for ${registration.domain.name}:`);
  out.lines.push(`${describeMailRouting(routing)}\n`);
  out.lines.push(formatDnsRecordsTable({ records: registration.dnsRecords, routing }));
}

async function executeCreateWebhook(opts: {
  action: Extract<ExecutableAction, { kind: 'create-webhook' }>;
  state: ExecutionState;
  targets: SecretTargets;
  deps: ManifestDeps;
  out: StepOutput;
}): Promise<void> {
  const { action, deps, out } = opts;
  const appId = requireAppId(opts.state);
  const sink = opts.targets.webhooks.get(action.secretEnv);
  if (sink === undefined || sink.kind !== 'vault') {
    throw new Error(`No secret sink for ${action.secretEnv}. Pass --vault. Nothing was created for ${action.url}.`);
  }

  let created: PigeonWebhookWithSecret;
  try {
    const result = await deps.client.createWebhook({
      adminSecret: deps.adminSecret,
      appId,
      url: action.url,
      eventTypes: action.events,
      expectedVersion: heldStateVersion(opts.state),
    });
    advanceStateVersion({ state: opts.state, returned: result.stateVersion });
    created = result;
  } catch (error) {
    if (error instanceof WebhookExistsError) {
      throw new Error(`Webhook ${error.webhookId} already exists for ${action.url}. Run plan again.`);
    }
    if (error instanceof PigeonHttpError && error.status < 500) throw error;
    throw new Error(
      `${errorMessage(error)}\nThe webhook may have been created. Run \`pigeon webhooks list ${appId}\` to check.`,
    );
  }

  const { webhook, signingSecret } = created;
  out.json.webhookId = webhook.id;
  try {
    await storeVaultSecret({ runBay: deps.runBay, target: sink.target, value: signingSecret });
  } catch (error) {
    out.failure = redactSecret({
      text:
        `Webhook ${webhook.id} was created, but the secret could not be stored in the Bay vault. ${errorMessage(error)}\n` +
        'The secret was not shown and is lost. Mint a new one with:\n' +
        `pigeon webhooks rotate ${appId} ${webhook.id} ${describeSinkFlags(sink)}`,
      secret: signingSecret,
    });
    return;
  }
  out.json.vault = { name: sink.target.name, env: sink.target.env, stored: true };
  out.lines.push(
    `Created webhook ${webhook.id} for ${webhook.url}. Secret for ${action.secretEnv} stored as ` +
      `${sink.target.name} (${sink.target.env}); the secret is not shown.`,
  );
}

async function executeAction(opts: {
  action: ExecutableAction;
  manifest: Manifest;
  state: ExecutionState;
  targets: SecretTargets;
  deps: ManifestDeps;
  out: StepOutput;
}): Promise<void> {
  const { action, deps, out, state } = opts;
  switch (action.kind) {
    case 'create-app':
      await executeCreateApp({ ...opts, action });
      return;
    case 'register-domain':
      await executeRegisterDomain({ ...opts, action });
      return;
    case 'create-audience': {
      const { audience, stateVersion } = await deps.client.createAudience({
        tenantKey: requireTenantKey(state),
        name: action.name,
        description: action.description,
        expectedVersion: heldStateVersion(state),
      });
      advanceStateVersion({ state, returned: stateVersion });
      out.json.audienceId = audience.id;
      const envHint = action.idEnv === null ? '' : ` Set ${action.idEnv}=${audience.id} in the app.`;
      out.lines.push(`Created audience "${audience.name}" (id: ${audience.id}).${envHint}`);
      return;
    }
    case 'add-inbound-domain': {
      const { inboundDomain, stateVersion } = await deps.client.addInboundDomain({
        adminSecret: deps.adminSecret,
        appId: requireAppId(state),
        name: action.name,
        expectedVersion: heldStateVersion(state),
      });
      advanceStateVersion({ state, returned: stateVersion });
      out.json.inboundDomainId = inboundDomain.id;
      out.lines.push(`Added inbound domain ${inboundDomain.name} (id: ${inboundDomain.id}). SES receiving is set up separately.`);
      return;
    }
    case 'create-webhook':
      await executeCreateWebhook({ ...opts, action });
      return;
    case 'update-webhook-events': {
      const { webhook, stateVersion } = await deps.client.updateWebhookEvents({
        adminSecret: deps.adminSecret,
        appId: requireAppId(state),
        webhookId: action.webhookId,
        eventTypes: action.events,
        expectedVersion: heldStateVersion(state),
      });
      advanceStateVersion({ state, returned: stateVersion });
      out.json.eventTypes = webhook.eventTypes;
      out.lines.push(`Webhook ${webhook.id} now receives: ${webhook.eventTypes?.join(', ') ?? '-'}`);
      return;
    }
    default: {
      const unreachable: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Runs the actions in order and stops at the first failure. */
async function runActions(opts: {
  actions: ExecutableAction[];
  manifest: Manifest;
  state: ExecutionState;
  targets: SecretTargets;
  isJson: boolean;
  deps: ManifestDeps;
}): Promise<StepRecord[]> {
  const records: StepRecord[] = [];
  let hasFailed = false;

  for (const action of opts.actions) {
    if (hasFailed) {
      records.push({ action, outcome: 'not-run', json: {}, error: null, conflict: null });
      continue;
    }
    const out: StepOutput = { lines: [], json: {}, failure: null, conflict: null };
    try {
      await executeAction({ ...opts, action, out });
    } catch (error) {
      out.failure = errorMessage(error);
      out.conflict = error instanceof StateVersionConflictError ? error : null;
    }
    if (!opts.isJson) for (const line of out.lines) opts.deps.io.log(line);
    hasFailed = out.failure !== null;
    records.push({
      action,
      outcome: hasFailed ? 'failed' : 'done',
      json: out.json,
      error: out.failure,
      conflict: out.conflict,
    });
  }
  return records;
}

/**
 * A guarded write got 412: another client changed the app after this run read
 * it. Lists what this run already applied and what it did not, then says to
 * plan again. The refused write itself changed nothing.
 */
function renderConflict(opts: {
  conflict: StateVersionConflictError;
  records: StepRecord[];
  manifest: Manifest;
  config: VaultConfig | null;
  io: ManifestIo;
}): void {
  const { io, conflict } = opts;
  const describe = (record: StepRecord): string =>
    describeAction({ action: record.action, manifest: opts.manifest, config: opts.config });
  const applied = opts.records.filter((record) => record.outcome === 'done');
  const notApplied = opts.records.filter((record) => record.outcome !== 'done');

  io.writeStderr(
    `Error: the app changed underneath this apply. This run held state version ${conflict.expected}, ` +
      `the server is at ${conflict.current}. The refused write changed nothing.`,
  );
  io.writeStderr(applied.length === 0 ? 'Already applied: nothing.' : 'Already applied:');
  for (const record of applied) io.writeStderr(`  done: ${describe(record)}`);
  io.writeStderr('Not applied:');
  for (const record of notApplied) io.writeStderr(`  ${record.outcome}: ${describe(record)}`);
  io.writeStderr(`Run \`pigeon manifest plan\` again, then apply. Exit ${EXIT_STATE_CONFLICT}.`);
}

/** Why apply may not run against this reading with this --state-version. Null when it may. */
function pinRefusal(opts: {
  pinned: number | undefined;
  reading: StateVersionReading;
}): { message: string; exitCode: number } | null {
  const { pinned, reading } = opts;
  if (pinned === undefined) return null;
  switch (reading.kind) {
    case 'known':
      if (reading.value === pinned) return null;
      return {
        message:
          `the app is at state version ${reading.value}, not ${pinned} (--state-version). ` +
          'It changed after that plan. Nothing was written. Run `pigeon manifest plan` again.',
        exitCode: EXIT_STATE_CONFLICT,
      };
    case 'no-app':
      return {
        message:
          `--state-version ${pinned} cannot match: ${reading.reason}, so it has no state version. ` +
          'Nothing was written. Run `pigeon manifest plan` again.',
        exitCode: EXIT_STATE_CONFLICT,
      };
    case 'unsupported':
      return { message: SERVER_TOO_OLD_MESSAGE, exitCode: EXIT_ERROR };
    case 'unread':
      return {
        message: 'no section of the app could be read, so --state-version cannot be checked. Nothing was written.',
        exitCode: EXIT_ERROR,
      };
    default: {
      const unreachable: never = reading;
      throw new Error(`Unknown state version reading: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The version the first guarded write of this run sends. A new app has none
 * yet (its create answer brings it). An existing app needs a known version, or
 * apply refuses before it writes anything.
 */
function startingStateVersion(live: ObservedInstance): { kind: 'ok'; value: number | null } | { kind: 'refused'; message: string } {
  if (live.app.kind !== 'found') return { kind: 'ok', value: null };
  switch (live.stateVersion.kind) {
    case 'known':
      return { kind: 'ok', value: live.stateVersion.value };
    case 'unsupported':
      return { kind: 'refused', message: SERVER_TOO_OLD_MESSAGE };
    case 'unread':
    case 'no-app':
      return { kind: 'refused', message: 'the app state version could not be read. Nothing was written.' };
    default: {
      const unreachable: never = live.stateVersion;
      throw new Error(`Unknown state version reading: ${JSON.stringify(unreachable)}`);
    }
  }
}

function renderFailure(opts: { records: StepRecord[]; manifest: Manifest; config: VaultConfig | null; io: ManifestIo }): void {
  const { io } = opts;
  const failed = opts.records.find((record) => record.outcome === 'failed');
  io.writeStderr(`Error: ${failed?.error ?? 'a write failed'}`);
  io.writeStderr('Stopped at the first failed write.');
  for (const record of opts.records) {
    const text = describeAction({ action: record.action, manifest: opts.manifest, config: opts.config });
    io.writeStderr(`  ${record.outcome}: ${text}`);
  }
}

/**
 * Domains and audiences are written through tenant routes, so a write needs a
 * key of this app. The key is checked only when apply has such a write to do.
 */
async function resolveWriteKey(opts: {
  plan: Plan;
  live: LiveState;
  tenantKey: string | null;
  deps: ManifestDeps;
}): Promise<WriteKeyStatus> {
  if (!needsTenantKeyForWrites(opts.plan)) return { kind: 'usable' };
  if (opts.live.app.kind !== 'found') return { kind: 'usable' };

  const access = await checkTenantKey({ appId: opts.live.app.id, tenantKey: opts.tenantKey, deps: opts.deps });
  if (access.kind === 'unusable') return access;
  return { kind: 'usable' };
}

export async function applyManifestCommand(opts: {
  source: ManifestSource;
  tenantKey: string | null;
  origin: string | undefined;
  isYes: boolean;
  vaultOpts: VaultCliOpts;
  /** `--state-version`: refuse before any write unless the fresh read equals it. */
  pinnedVersion?: number;
  isJson: boolean;
  deps: ManifestDeps;
}): Promise<number> {
  const { deps } = opts;
  const { io } = deps;
  const manifest = loadManifest({ source: opts.source, isJson: opts.isJson, io });
  if (manifest === null) return EXIT_ERROR;
  const origin = opts.origin === undefined ? null : parseOrigin(opts.origin);
  const config = resolveVaultConfig(opts.vaultOpts);

  const live = await observeLiveState({ manifest, tenantKey: opts.tenantKey, deps });
  const plan = buildPlan({ manifest, live, origin });
  const writeKey = await resolveWriteKey({ plan, live, tenantKey: opts.tenantKey, deps });
  const actions = planActions({ plan, manifest, context: { hasWebhookSecretSink: config !== null, writeKey } });
  const executable = actions.filter(isExecutable);
  const blocked = actions.filter((action) => !isExecutable(action));
  const actionLines = actions.map((action) => describeAction({ action, manifest, config }));

  const stateVersion = live.stateVersion;
  const planOutput = { plan, manifest, path: opts.source.path, stateVersion };
  if (!opts.isJson) {
    renderPlanText({ ...planOutput, io });
    io.log('');
    io.log(actions.length === 0 ? 'Actions: none.' : 'Actions:');
    for (const line of actionLines) io.log(`  ${line}`);
  }

  const refusal = pinRefusal({ pinned: opts.pinnedVersion, reading: stateVersion });
  if (refusal !== null) {
    if (opts.isJson) {
      io.log(JSON.stringify({ applied: false, plan: planJson(planOutput), error: refusal.message, exitCode: refusal.exitCode }, null, 2));
    }
    io.writeStderr(`Error: ${refusal.message}`);
    return refusal.exitCode;
  }

  if (!opts.isYes) {
    const code = executable.length > 0 ? EXIT_CHANGES_NEEDED : planExitCode(plan);
    if (opts.isJson) {
      io.log(JSON.stringify({ applied: false, plan: planJson(planOutput), actions: actionLines, exitCode: code }, null, 2));
      return code;
    }
    if (executable.length > 0) io.log('\nDry run: nothing was changed. Run again with --yes to apply.');
    return code;
  }

  const start = startingStateVersion(live);
  if (start.kind === 'refused' && executable.length > 0) {
    if (opts.isJson) io.log(JSON.stringify({ applied: false, error: start.message, exitCode: EXIT_ERROR }, null, 2));
    io.writeStderr(`Error: ${start.message}`);
    return EXIT_ERROR;
  }

  const targets = await prepareSecretTargets({ actions: executable, manifest, config, runBay: deps.runBay });
  const state: ExecutionState = {
    appId: live.app.kind === 'found' ? live.app.id : null,
    tenantKey: opts.tenantKey,
    stateVersion: start.kind === 'ok' ? start.value : null,
  };
  const records = await runActions({ actions: executable, manifest, state, targets, isJson: opts.isJson, deps });
  const steps = records.map((record) => ({
    action: describeAction({ action: record.action, manifest, config }),
    outcome: record.outcome,
    ...record.json,
    ...(record.error === null ? {} : { error: record.error }),
  }));

  const conflict = records.find((record) => record.conflict !== null)?.conflict ?? null;
  if (conflict !== null) {
    if (opts.isJson) {
      io.log(
        JSON.stringify(
          {
            applied: false,
            conflict: { expected: conflict.expected, current: conflict.current },
            steps,
            exitCode: EXIT_STATE_CONFLICT,
          },
          null,
          2,
        ),
      );
    }
    renderConflict({ conflict, records, manifest, config, io });
    return EXIT_STATE_CONFLICT;
  }

  if (records.some((record) => record.outcome === 'failed')) {
    if (opts.isJson) io.log(JSON.stringify({ applied: false, steps, blocked: blocked.length, exitCode: EXIT_ERROR }, null, 2));
    renderFailure({ records, manifest, config, io });
    return EXIT_ERROR;
  }

  const liveAfter = await observeLiveState({ manifest, tenantKey: state.tenantKey, deps });
  const after = buildPlan({ manifest, live: liveAfter, origin });
  const afterOutput = { plan: after, manifest, path: opts.source.path, stateVersion: liveAfter.stateVersion };
  const code = planExitCode(after);
  if (opts.isJson) {
    io.log(JSON.stringify({ applied: true, steps, after: planJson(afterOutput), exitCode: code }, null, 2));
    return code;
  }
  io.log('');
  io.log(`Applied ${records.length} action(s)${blocked.length > 0 ? `, ${blocked.length} blocked` : ''}. Plan after apply:`);
  io.log('');
  renderPlanText({ ...afterOutput, io });
  return code;
}
