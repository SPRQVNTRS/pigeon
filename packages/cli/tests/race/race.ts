/**
 * Real two-process race against a running pigeon: two shells, one tenant, the
 * same pigeon.toml, both at once. One wins, the other gets the conflict, and
 * no duplicate exists. Not part of `pnpm test`; run it with `pnpm test:race`.
 *
 * Needs PIGEON_ADMIN_URL and PIGEON_ADMIN_SECRET of a LOCAL instance. It
 * creates a throwaway app with a unique name and never deletes anything, so
 * point it at a database you can drop. Nothing here needs AWS: it uses
 * audiences, inbound domains and webhooks only. Webhook secrets go to a stub
 * `bay` (BAY_BIN) that keeps them in a temp directory per process, which this
 * script removes at the end.
 *
 * Scenario A: N rounds, each with a fresh manifest. Two `manifest apply --yes`
 *   processes start at the same moment. Per round: no item exists twice, the
 *   final state equals the manifest, each process exits 0 or 30 (never 1), a
 *   process that exited 30 succeeds on a re-run, and the state version moved by
 *   exactly the number of declared items (one bump per create, none lost).
 * Scenario B: two processes rotate the same webhook secret at once.
 *   Pinned rounds (both pass --state-version of one read, so both act on the
 *   same view): exactly one exits 0 with a secret, the other exits 30.
 *   Free rounds (no pin): each exits 0 or 30, and the version moves by the
 *   number of successes.
 * Scenario C: plan on A, change the app from B, then `apply --state-version`
 *   with the plan's version on A refuses before any write.
 * Scenario D: two processes run `apps create <name>` with one new name at
 *   once. Exactly one app with that name exists afterwards; one process exits
 *   0, the other exits 1 with the "already exists" message (the same end as
 *   the client-side duplicate check), never with anything else. Checked rounds
 *   run the client-side check first; forced rounds pass --force, so the loser
 *   can only be stopped by the server's unique index (409).
 *
 * Env: RACE_ROUNDS (default 20), RACE_ROTATE_ROUNDS (default 10),
 * RACE_CREATE_ROUNDS (default 10 per mode), RACE_TMP (default the OS temp dir).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PigeonClient } from '../../src/lib/pigeon-client.js';
import { EXIT_STATE_CONFLICT } from '../../src/lib/state-version.js';

const CLI_PATH = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
// Resolved here, not by the child: the children run in temp directories with no node_modules.
const TSX_LOADER = import.meta.resolve('tsx');
const ORIGIN = 'https://hooks.example.com';
const AUDIENCES_PER_ROUND = 6;
const WEBHOOKS_PER_ROUND = 2;
const INBOUND_PER_ROUND = 1;
const ITEMS_PER_ROUND = AUDIENCES_PER_ROUND + WEBHOOKS_PER_ROUND + INBOUND_PER_ROUND;
const SECRET_PATTERN = /^[0-9a-f]{64}\n$/;

const FAKE_BAY = `#!/usr/bin/env node
// Stub of \`bay vault\` for the race test: one JSON file per --fleet directory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const fleet = args[1];
const verb = args[3];
const name = args[5];
const store = path.join(fleet, 'vault.json');
const secrets = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {};
if (verb === 'view') {
  const lines = Object.entries(secrets).map(([key, value]) => '  ' + key + ': ' + value);
  process.stdout.write('secrets:\\n' + lines.join('\\n') + '\\n');
  process.exit(0);
}
if (verb === 'set') {
  secrets[name] = readFileSync(0, 'utf8');
  writeFileSync(store, JSON.stringify(secrets));
  process.exit(0);
}
process.stderr.write('stub bay: unsupported command\\n');
process.exit(2);
`;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RaceContext {
  client: PigeonClient;
  adminSecret: string;
  appId: string;
  appName: string;
  tenantKey: string;
  root: string;
  childEnv: NodeJS.ProcessEnv;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Point the race test at a local pigeon.`);
  return value;
}

function runCli(opts: { args: string[]; ctx: RaceContext; cwd: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_PATH, ...opts.args], {
      cwd: opts.cwd,
      env: opts.ctx.childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }),
    );
  });
}

async function stateVersion(ctx: RaceContext): Promise<number> {
  const version = await ctx.client.getAppStateVersion({ adminSecret: ctx.adminSecret, appId: ctx.appId });
  if (version === null) throw new Error('The server sent no Pigeon-State-Version header.');
  return version;
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

/** The first line that names an error, else the last line: enough to tell a crash from a refusal. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  const errorLine = lines.find((line) => /error/i.test(line));
  return (errorLine ?? lines[lines.length - 1] ?? '').slice(0, 160);
}

async function setUp(): Promise<RaceContext> {
  const adminUrl = requireEnv('PIGEON_ADMIN_URL');
  const adminSecret = requireEnv('PIGEON_ADMIN_SECRET');
  const client = new PigeonClient({ baseUrl: adminUrl });
  const suffix = randomBytes(4).toString('hex');
  const appName = `race-${suffix}`;

  const { app } = await client.createApp({ adminSecret, name: appName });
  const { plaintext } = await client.createApiKey({ adminSecret, appId: app.id, name: 'race' });

  const root = mkdtempSync(path.join(process.env.RACE_TMP ?? os.tmpdir(), 'pigeon-race-'));
  const bayBin = path.join(root, 'stub-bay.mjs');
  writeFileSync(bayBin, FAKE_BAY);
  chmodSync(bayBin, 0o755);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PIGEON_ADMIN_URL: adminUrl,
    PIGEON_ADMIN_SECRET: adminSecret,
    // The tenant key goes to the children in the environment, never in argv.
    PIGEON_TENANT_KEY: plaintext,
    BAY_BIN: bayBin,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  delete childEnv.INIT_CWD;
  delete childEnv.PIGEON_BAY_FLEET;

  return { client, adminSecret, appId: app.id, appName, tenantKey: plaintext, root, childEnv };
}

// ---------------------------------------------------------------------------
// Scenario A
// ---------------------------------------------------------------------------

interface RoundNames {
  audiences: string[];
  webhookPaths: string[];
  inbound: string[];
}

function roundNames(opts: { round: number; appName: string }): RoundNames {
  const { round, appName } = opts;
  return {
    audiences: Array.from({ length: AUDIENCES_PER_ROUND }, (_, index) => `${appName}-r${round}-aud-${index}`),
    webhookPaths: Array.from({ length: WEBHOOKS_PER_ROUND }, (_, index) => `/hooks/r${round}-${index}`),
    inbound: Array.from({ length: INBOUND_PER_ROUND }, (_, index) => `r${round}-${index}.${appName}.example.com`),
  };
}

function manifestFor(opts: { appName: string; names: RoundNames; round: number }): string {
  const { names } = opts;
  const audiences = names.audiences.map((name) => `[[audiences]]\nname = "${name}"\n`).join('\n');
  const webhooks = names.webhookPaths
    .map(
      (hookPath, index) =>
        `[[webhooks]]\npath = "${hookPath}"\nevents = ["email.bounced", "email.complained"]\n` +
        `secret_env = "RACE_R${opts.round}_HOOK_${index}_SECRET"\n`,
    )
    .join('\n');
  const inbound = names.inbound.map((domain) => `[[inbound]]\ndomain = "${domain}"\n`).join('\n');
  return (
    `schema = 1\napp = "${opts.appName}"\n\n[env]\napi_key = "RACE_PIGEON_API_KEY"\nbase_url = "RACE_PIGEON_BASE_URL"\n\n` +
    `${audiences}\n${webhooks}\n${inbound}`
  );
}

function applyArgs(opts: { manifestPath: string; fleet: string; extra?: string[] }): string[] {
  return [
    'manifest',
    'apply',
    opts.manifestPath,
    '--yes',
    '--origin',
    ORIGIN,
    '--vault',
    '--fleet',
    opts.fleet,
    ...(opts.extra ?? []),
  ];
}

interface RoundRow {
  round: number;
  codes: string;
  /** Per process that exited 30: how many of its own writes landed before the 412. */
  refusedAfter: string;
  reruns: string;
  versionDelta: number;
  duplicates: number;
  missing: number;
  planCode: number | null;
  violations: string[];
}

async function checkRoundState(opts: { ctx: RaceContext; names: RoundNames }): Promise<{ duplicates: number; missing: number }> {
  const { ctx, names } = opts;
  const [audiences, webhooks, inbound] = await Promise.all([
    ctx.client.listAppAudiences({ adminSecret: ctx.adminSecret, appId: ctx.appId }),
    ctx.client.listWebhooks({ adminSecret: ctx.adminSecret, appId: ctx.appId }),
    ctx.client.listInboundDomains({ adminSecret: ctx.adminSecret, appId: ctx.appId }),
  ]);
  const audienceCounts = countBy(audiences.audiences, (audience) => audience.name);
  const webhookCounts = countBy(webhooks.webhooks, (hook) => hook.url);
  const inboundCounts = countBy(inbound.inboundDomains, (domain) => domain.name);
  const expected = [
    ...names.audiences.map((name) => audienceCounts.get(name) ?? 0),
    ...names.webhookPaths.map((hookPath) => webhookCounts.get(`${ORIGIN}${hookPath}`) ?? 0),
    ...names.inbound.map((domain) => inboundCounts.get(domain) ?? 0),
  ];
  return {
    duplicates: expected.filter((count) => count > 1).length,
    missing: expected.filter((count) => count === 0).length,
  };
}

/** The writes a refused apply reports under "Already applied". */
function countOwnWrites(stderr: string): number {
  return stderr.split('\n').filter((line) => line.startsWith('  done: ')).length;
}

async function raceRound(opts: { ctx: RaceContext; round: number }): Promise<RoundRow> {
  const { ctx, round } = opts;
  const dir = path.join(ctx.root, `round-${round}`);
  const fleets = [path.join(dir, 'fleet-1'), path.join(dir, 'fleet-2')];
  for (const fleet of fleets) mkdirSync(fleet, { recursive: true });
  const names = roundNames({ round, appName: ctx.appName });
  const manifestPath = path.join(dir, 'pigeon.toml');
  writeFileSync(manifestPath, manifestFor({ appName: ctx.appName, names, round }));

  const before = await stateVersion(ctx);
  // Both processes are spawned in the same tick.
  const results = await Promise.all(
    fleets.map((fleet) => runCli({ args: applyArgs({ manifestPath, fleet }), ctx, cwd: dir })),
  );
  const violations: string[] = [];
  results.forEach((result, index) => {
    if (result.code === 0 || result.code === EXIT_STATE_CONFLICT) return;
    violations.push(`process ${index + 1} exited ${result.code}: ${lastLine(result.stderr)}`);
  });

  const refusedAfter = results
    .filter((result) => result.code === EXIT_STATE_CONFLICT)
    .map((result) => `412 after ${countOwnWrites(result.stderr)}`);

  const reruns: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.code !== EXIT_STATE_CONFLICT) continue;
    const fleet = fleets[index] ?? '';
    const rerun = await runCli({ args: applyArgs({ manifestPath, fleet }), ctx, cwd: dir });
    reruns.push(String(rerun.code));
    if (rerun.code !== 0) violations.push(`re-run of process ${index + 1} exited ${rerun.code}: ${lastLine(rerun.stderr)}`);
  }

  const after = await stateVersion(ctx);
  const { duplicates, missing } = await checkRoundState({ ctx, names });
  if (duplicates > 0) violations.push(`${duplicates} declared item(s) exist more than once`);
  if (missing > 0) violations.push(`${missing} declared item(s) are missing`);
  if (after - before !== ITEMS_PER_ROUND) {
    violations.push(`state version moved by ${after - before}, expected ${ITEMS_PER_ROUND} (one bump per item)`);
  }

  const plan = await runCli({ args: ['manifest', 'plan', manifestPath, '--origin', ORIGIN], ctx, cwd: dir });
  if (plan.code !== 0) violations.push(`plan after the round exited ${plan.code}`);

  return {
    round,
    codes: results.map((result) => String(result.code)).join('/'),
    refusedAfter: refusedAfter.join('/') || '-',
    reruns: reruns.join('/') || '-',
    versionDelta: after - before,
    duplicates,
    missing,
    planCode: plan.code,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Scenario B
// ---------------------------------------------------------------------------

interface RotateRow {
  round: number;
  mode: 'pinned' | 'free';
  codes: string;
  versionDelta: number;
  violations: string[];
}

async function rotateRound(opts: { ctx: RaceContext; webhookId: string; round: number; isPinned: boolean }): Promise<RotateRow> {
  const { ctx, webhookId, round, isPinned } = opts;
  const before = await stateVersion(ctx);
  const pin = isPinned ? ['--state-version', String(before)] : [];
  const args = ['webhooks', 'rotate', ctx.appId, webhookId, '--secret-stdout', ...pin];
  const results = await Promise.all([runCli({ args, ctx, cwd: ctx.root }), runCli({ args, ctx, cwd: ctx.root })]);
  const after = await stateVersion(ctx);

  const violations: string[] = [];
  const winners = results.filter((result) => result.code === 0);
  const losers = results.filter((result) => result.code === EXIT_STATE_CONFLICT);
  for (const result of results) {
    if (result.code !== 0 && result.code !== EXIT_STATE_CONFLICT) {
      violations.push(`a process exited ${result.code}: ${lastLine(result.stderr)}`);
    }
  }
  for (const winner of winners) {
    if (!SECRET_PATTERN.test(winner.stdout)) violations.push('a winner did not print exactly one secret');
  }
  for (const loser of losers) {
    if (loser.stdout !== '') violations.push('a loser wrote to stdout');
  }
  if (winners.length === 0) violations.push('no process rotated the secret');
  if (isPinned && (winners.length !== 1 || losers.length !== 1)) {
    violations.push(`pinned round: expected one 0 and one 30, got ${results.map((result) => result.code).join('/')}`);
  }
  if (after - before !== winners.length) {
    violations.push(`state version moved by ${after - before}, expected ${winners.length} (one per successful rotate)`);
  }

  return {
    round,
    mode: isPinned ? 'pinned' : 'free',
    codes: results.map((result) => String(result.code)).join('/'),
    versionDelta: after - before,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Scenario C
// ---------------------------------------------------------------------------

interface PinRow {
  step: string;
  outcome: string;
  violations: string[];
}

async function stalePlanScenario(ctx: RaceContext): Promise<PinRow[]> {
  const dir = path.join(ctx.root, 'scenario-c');
  const fleet = path.join(dir, 'fleet');
  mkdirSync(fleet, { recursive: true });
  const names: RoundNames = { audiences: [`${ctx.appName}-c-aud`], webhookPaths: [], inbound: [] };
  const manifestPath = path.join(dir, 'pigeon.toml');
  writeFileSync(manifestPath, manifestFor({ appName: ctx.appName, names, round: 999 }));
  const rows: PinRow[] = [];

  const plan = await runCli({ args: ['--json', 'manifest', 'plan', manifestPath, '--origin', ORIGIN], ctx, cwd: dir });
  if (plan.stdout.trim() === '') throw new Error(`plan --json printed nothing (exit ${plan.code}): ${lastLine(plan.stderr)}`);
  const plannedVersion = (JSON.parse(plan.stdout) as { stateVersion: number | null }).stateVersion;
  const planViolations = plannedVersion === null ? ['plan printed no state version'] : [];
  rows.push({ step: 'A: plan', outcome: `exit ${plan.code}, state version ${plannedVersion}`, violations: planViolations });

  await ctx.client.createAudience({ tenantKey: ctx.tenantKey, name: `${ctx.appName}-c-other`, description: null });
  const afterB = await stateVersion(ctx);
  rows.push({ step: 'B: create an audience', outcome: `state version ${afterB}`, violations: [] });

  const stale = await runCli({
    args: applyArgs({ manifestPath, fleet, extra: ['--state-version', String(plannedVersion)] }),
    ctx,
    cwd: dir,
  });
  const afterStale = await stateVersion(ctx);
  const { missing } = await checkRoundState({ ctx, names });
  const staleViolations: string[] = [];
  if (stale.code !== EXIT_STATE_CONFLICT) staleViolations.push(`expected exit 30, got ${stale.code}`);
  if (afterStale !== afterB) staleViolations.push(`state version moved from ${afterB} to ${afterStale}: a write happened`);
  if (missing !== 1) staleViolations.push('the declared audience was created');
  rows.push({
    step: `A: apply --state-version ${plannedVersion}`,
    outcome: `exit ${stale.code}, state version ${afterStale}, ${lastLine(stale.stderr)}`,
    violations: staleViolations,
  });

  const fresh = await runCli({
    args: applyArgs({ manifestPath, fleet, extra: ['--state-version', String(afterB)] }),
    ctx,
    cwd: dir,
  });
  rows.push({
    step: `A: apply --state-version ${afterB}`,
    outcome: `exit ${fresh.code}`,
    violations: fresh.code === 0 ? [] : [`expected exit 0, got ${fresh.code}: ${lastLine(fresh.stderr)}`],
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Scenario D
// ---------------------------------------------------------------------------

const DUPLICATE_MESSAGE = /An app named "[^"]+" already exists( \(id: [^)]+\))?\. App names are unique\./;

interface CreateRow {
  round: number;
  mode: 'checked' | 'forced';
  codes: string;
  apps: number;
  loser: string;
  violations: string[];
}

async function createRound(opts: { ctx: RaceContext; round: number; isForced: boolean }): Promise<CreateRow> {
  const { ctx, round, isForced } = opts;
  const mode = isForced ? 'forced' : 'checked';
  const name = `${ctx.appName}-d${round}-${mode}`;
  const args = ['apps', 'create', name, ...(isForced ? ['--force'] : [])];
  // Both processes are spawned in the same tick.
  const results = await Promise.all([runCli({ args, ctx, cwd: ctx.root }), runCli({ args, ctx, cwd: ctx.root })]);
  const { apps } = await ctx.client.listApps({ adminSecret: ctx.adminSecret });
  const count = apps.filter((app) => app.name === name).length;

  const violations: string[] = [];
  const winners = results.filter((result) => result.code === 0);
  const losers = results.filter((result) => result.code !== 0);
  if (count !== 1) violations.push(`${count} apps named ${name} exist, expected exactly 1`);
  if (winners.length !== 1) violations.push(`${winners.length} processes exited 0, expected exactly 1`);
  for (const loser of losers) {
    if (loser.code !== 1 || !DUPLICATE_MESSAGE.test(loser.stderr)) {
      violations.push(`a process exited ${loser.code}: ${lastLine(loser.stderr)}`);
    }
  }

  return {
    round,
    mode,
    codes: results.map((result) => String(result.code)).join('/'),
    apps: count,
    loser: losers.map((loser) => lastLine(loser.stderr).replace(name, '<name>')).join(' | ') || '-',
    violations,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ');
  process.stdout.write(`${line(headers)}\n${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

async function main(): Promise<number> {
  const rounds = Number(process.env.RACE_ROUNDS ?? 20);
  const rotateRounds = Number(process.env.RACE_ROTATE_ROUNDS ?? 10);
  const createRounds = Number(process.env.RACE_CREATE_ROUNDS ?? 10);
  const ctx = await setUp();
  const violations: string[] = [];
  process.stdout.write(`Race app ${ctx.appName} (${ctx.appId}), temp dir ${ctx.root}\n\n`);

  try {
    const roundRows: RoundRow[] = [];
    for (let round = 1; round <= rounds; round += 1) roundRows.push(await raceRound({ ctx, round }));
    process.stdout.write(`Scenario A: two concurrent \`manifest apply --yes\`, ${ITEMS_PER_ROUND} items per round\n`);
    printTable(
      ['round', 'exits', 'loser', 'rerun', 'dVersion', 'dups', 'missing', 'plan', 'result'],
      roundRows.map((row) => [
        String(row.round),
        row.codes,
        row.refusedAfter,
        row.reruns,
        String(row.versionDelta),
        String(row.duplicates),
        String(row.missing),
        String(row.planCode),
        row.violations.length === 0 ? 'ok' : row.violations.join('; '),
      ]),
    );
    const conflicted = roundRows.filter((row) => row.codes.includes(String(EXIT_STATE_CONFLICT))).length;
    process.stdout.write(`${conflicted} of ${rounds} rounds had a process exit 30 (a real 412 or a version moved under it).\n\n`);
    violations.push(...roundRows.flatMap((row) => row.violations.map((text) => `A round ${row.round}: ${text}`)));

    const created = await ctx.client.createWebhook({
      adminSecret: ctx.adminSecret,
      appId: ctx.appId,
      url: `${ORIGIN}/hooks/rotate-race`,
      eventTypes: ['email.bounced'],
    });
    const rotateRows: RotateRow[] = [];
    for (let round = 1; round <= rotateRounds; round += 1) {
      rotateRows.push(await rotateRound({ ctx, webhookId: created.webhook.id, round, isPinned: true }));
    }
    for (let round = 1; round <= rotateRounds; round += 1) {
      rotateRows.push(await rotateRound({ ctx, webhookId: created.webhook.id, round, isPinned: false }));
    }
    process.stdout.write('Scenario B: two concurrent `webhooks rotate` of one webhook\n');
    printTable(
      ['round', 'mode', 'exits', 'dVersion', 'result'],
      rotateRows.map((row) => [
        String(row.round),
        row.mode,
        row.codes,
        String(row.versionDelta),
        row.violations.length === 0 ? 'ok' : row.violations.join('; '),
      ]),
    );
    const freeCollisions = rotateRows.filter((row) => row.mode === 'free' && row.codes.includes('30')).length;
    process.stdout.write(`${freeCollisions} of ${rotateRounds} free rounds collided.\n\n`);
    violations.push(...rotateRows.flatMap((row) => row.violations.map((text) => `B ${row.mode} ${row.round}: ${text}`)));

    const pinRows = await stalePlanScenario(ctx);
    process.stdout.write('Scenario C: plan on A, change from B, apply --state-version on A\n');
    printTable(
      ['step', 'outcome', 'result'],
      pinRows.map((row) => [row.step, row.outcome, row.violations.length === 0 ? 'ok' : row.violations.join('; ')]),
    );
    violations.push(...pinRows.flatMap((row) => row.violations.map((text) => `C ${row.step}: ${text}`)));

    const createRows: CreateRow[] = [];
    for (let round = 1; round <= createRounds; round += 1) {
      createRows.push(await createRound({ ctx, round, isForced: false }));
    }
    for (let round = 1; round <= createRounds; round += 1) {
      createRows.push(await createRound({ ctx, round, isForced: true }));
    }
    process.stdout.write('\nScenario D: two concurrent `apps create` of one new name\n');
    printTable(
      ['round', 'mode', 'exits', 'apps', 'loser', 'result'],
      createRows.map((row) => [
        String(row.round),
        row.mode,
        row.codes,
        String(row.apps),
        row.loser,
        row.violations.length === 0 ? 'ok' : row.violations.join('; '),
      ]),
    );
    violations.push(...createRows.flatMap((row) => row.violations.map((text) => `D ${row.mode} ${row.round}: ${text}`)));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }

  process.stdout.write(`\n${violations.length === 0 ? 'PASS' : `FAIL: ${violations.length} violation(s)`}\n`);
  for (const violation of violations) process.stdout.write(`  ${violation}\n`);
  return violations.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Race test error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
