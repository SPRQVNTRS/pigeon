import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { applyManifestCommand, planManifestCommand } from '../src/commands/manifest.js';
import type { ManifestDeps, VaultCliOpts } from '../src/commands/manifest.js';
import { rotateWebhookCommand, updateWebhookCommand } from '../src/commands/webhooks.js';
import { EXIT_CHANGES_NEEDED, EXIT_ERROR } from '../src/lib/manifest-plan.js';
import { PigeonClient } from '../src/lib/pigeon-client.js';
import {
  EXIT_STATE_CONFLICT,
  ServerTooOldForGuardedWritesError,
  StateVersionConflictError,
  StateVersionPinError,
  parseStateVersionHeader,
  parseStateVersionOption,
  summarizeStateVersions,
} from '../src/lib/state-version.js';
import {
  APP_ID,
  FULL_MANIFEST,
  ORIGIN,
  TENANT_KEY,
  bumpStateVersion,
  makeEmptyInstance,
  makeFakeClient,
  makeInSyncInstance,
  makeManifestDeps,
  makeManifestIo,
} from './manifest-test-helpers.js';
import type { FakeInstance } from './manifest-test-helpers.js';
import { SECRET, STATE_VERSION, makeDeps, makeFakeVault, makeFleetDir, makeIo, makeWebhook } from './webhook-test-helpers.js';

const execFileAsync = promisify(execFile);

/** The app exists at state version 7 with its key, but none of the declared items. */
function makeBareAppInstance(): FakeInstance {
  const instance = makeInSyncInstance();
  instance.domains = [];
  instance.audiences = [];
  instance.webhooks = [];
  instance.inboundDomains = [];
  return instance;
}

function withVault(): VaultCliOpts {
  return { vault: true, vaultPrefix: 'MYAPP_', vaultEnv: 'production', fleet: makeFleetDir() };
}

async function apply(opts: {
  deps: ManifestDeps;
  isYes?: boolean;
  pinnedVersion?: number;
  isJson?: boolean;
}): Promise<number> {
  return applyManifestCommand({
    source: { path: 'pigeon.toml', text: FULL_MANIFEST },
    tenantKey: TENANT_KEY,
    origin: ORIGIN,
    isYes: opts.isYes ?? true,
    vaultOpts: withVault(),
    pinnedVersion: opts.pinnedVersion,
    isJson: opts.isJson ?? false,
    deps: opts.deps,
  });
}

const WRITE_METHODS = ['createApp', 'createApiKey', 'registerDomain', 'createAudience', 'createWebhook', 'updateWebhookEvents', 'addInboundDomain'];

describe('state version helpers', () => {
  it('parses the header: absent is null, a whole number is read, anything else throws', () => {
    assert.equal(parseStateVersionHeader(null), null);
    assert.equal(parseStateVersionHeader(' 12 '), 12);
    assert.throws(() => parseStateVersionHeader('"12"'), /malformed Pigeon-State-Version/);
    assert.throws(() => parseStateVersionHeader('-1'), /malformed/);
  });

  it('parses --state-version as a whole number, 0 or more', () => {
    assert.equal(parseStateVersionOption('0'), 0);
    assert.throws(() => parseStateVersionOption('v3'), /--state-version must be a whole number/);
  });

  it('folds an observation into the lowest version, or says why there is none', () => {
    assert.deepEqual(summarizeStateVersions([5, 4, 5]), { kind: 'known', value: 4 });
    assert.deepEqual(summarizeStateVersions([5, null]), { kind: 'unsupported' });
    assert.deepEqual(summarizeStateVersions([]), { kind: 'unread' });
  });
});

describe('manifest plan prints the state version', () => {
  it('in text and in --json', async () => {
    const text = makeManifestIo();
    const { client } = makeFakeClient({ instance: makeInSyncInstance() });
    await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: text.io }),
    });
    assert.match(text.allOutput(), /^State version: 7$/m);

    const json = makeManifestIo();
    await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: true,
      deps: makeManifestDeps({ client, io: json.io }),
    });
    assert.equal(JSON.parse(json.stdout.join('')).stateVersion, 7);
  });

  it('says there is none when the app does not exist yet', async () => {
    const capture = makeManifestIo();
    const { client } = makeFakeClient({ instance: makeEmptyInstance() });
    await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.match(capture.allOutput(), /^State version: none \(app "my-app" does not exist on this instance\)$/m);
  });

  it('says the server is too old when a read has no header', async () => {
    const capture = makeManifestIo();
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), hasStateVersion: false });
    await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.match(capture.allOutput(), /State version: unknown \(.*too old for guarded writes\)/);
  });
});

describe('manifest apply guards every write with If-Match', () => {
  it('chains the version each write returns into the next If-Match', async () => {
    const fake = makeFakeClient({ instance: makeBareAppInstance() });
    const vault = makeFakeVault();
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: makeManifestIo().io, runBay: vault.runBay }) });

    assert.deepEqual(fake.ifMatch, ['registerDomain:7', 'createAudience:8', 'addInboundDomain:9', 'createWebhook:10']);
    // The new domain is unverified until its DNS is published.
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('chains a new app from the version its create answer brings', async () => {
    const fake = makeFakeClient({ instance: makeEmptyInstance() });
    const vault = makeFakeVault();
    await applyManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isYes: true,
      vaultOpts: withVault(),
      isJson: false,
      deps: makeManifestDeps({ client: fake.client, io: makeManifestIo().io, runBay: vault.runBay }),
    });
    assert.deepEqual(fake.ifMatch, ['registerDomain:0', 'createAudience:1', 'addInboundDomain:2', 'createWebhook:3']);
  });

  it('stops at a 412, reports what was applied, and exits 30', async () => {
    const instance = makeBareAppInstance();
    // Another machine changes the app just before this run creates the audience.
    const fake = makeFakeClient({
      instance,
      beforeWrite: (method) => {
        if (method === 'createAudience') bumpStateVersion({ instance, appId: APP_ID });
      },
    });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: capture.io }) });

    assert.equal(code, EXIT_STATE_CONFLICT);
    assert.deepEqual(fake.writes, ['registerDomain:example.test']);
    assert.equal(instance.audiences.length, 0);
    const stderr = capture.stderr.join('');
    assert.match(stderr, /the app changed underneath this apply\. This run held state version 8, the server is at 9/);
    assert.match(stderr, /Already applied:\n {2}done: register sending domain example\.test/);
    assert.match(stderr, /Not applied:\n {2}failed: create audience "product-updates"/);
    assert.match(stderr, /not-run: add inbound domain reply\.example\.test/);
    assert.match(stderr, /Run `pigeon manifest plan` again, then apply\. Exit 30\./);
  });

  it('reports the conflict in --json', async () => {
    const instance = makeBareAppInstance();
    const fake = makeFakeClient({
      instance,
      beforeWrite: (method) => {
        if (method === 'registerDomain') bumpStateVersion({ instance, appId: APP_ID });
      },
    });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: capture.io }), isJson: true });

    assert.equal(code, EXIT_STATE_CONFLICT);
    const output = JSON.parse(capture.stdout.join(''));
    assert.deepEqual(output.conflict, { expected: 7, current: 8 });
    assert.equal(output.exitCode, EXIT_STATE_CONFLICT);
    assert.deepEqual(fake.writes, []);
  });

  it('with --state-version, refuses before any write when the app moved on', async () => {
    const fake = makeFakeClient({ instance: makeBareAppInstance() });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: capture.io }), pinnedVersion: 6 });

    assert.equal(code, EXIT_STATE_CONFLICT);
    assert.deepEqual(fake.writes, []);
    assert.equal(fake.calls.some((method) => WRITE_METHODS.includes(method)), false);
    assert.match(capture.stderr.join(''), /the app is at state version 7, not 6 \(--state-version\)\. .*Nothing was written/);
  });

  it('with --state-version, refuses a dry run the same way', async () => {
    const fake = makeFakeClient({ instance: makeBareAppInstance() });
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: makeManifestIo().io }), pinnedVersion: 6, isYes: false });
    assert.equal(code, EXIT_STATE_CONFLICT);
  });

  it('with a matching --state-version, applies', async () => {
    const fake = makeFakeClient({ instance: makeBareAppInstance() });
    const code = await apply({
      deps: makeManifestDeps({ client: fake.client, io: makeManifestIo().io, runBay: makeFakeVault().runBay }),
      pinnedVersion: 7,
    });
    assert.equal(code, EXIT_CHANGES_NEEDED);
    assert.equal(fake.writes.length, 4);
  });

  it('refuses to write unguarded when the server sends no state version', async () => {
    const fake = makeFakeClient({ instance: makeBareAppInstance(), hasStateVersion: false });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client: fake.client, io: capture.io }) });

    assert.equal(code, EXIT_ERROR);
    assert.deepEqual(fake.writes, []);
    assert.match(capture.stderr.join(''), /too old for guarded writes/);
  });
});

describe('webhooks rotate and update are guarded', () => {
  const BASE = { appId: 'app_1', webhookId: 'wh_1', isJson: false, isStdoutTty: false };
  const STDOUT_SINK = { secretStdout: true, vaultEnv: 'production' };

  it('rotate reads the version and sends it as If-Match', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await rotateWebhookCommand({ ...BASE, sinkOpts: STDOUT_SINK, deps });
    assert.deepEqual(deps.apiCalls, ['version', `rotate:${STATE_VERSION}`]);
  });

  it('rotate maps a 412 to StateVersionConflictError, says the old secret works, and prints no secret', async () => {
    const captured = makeIo();
    const deps = makeDeps({
      io: captured.io,
      client: {
        rotateWebhookSecret: async ({ expectedVersion }) => {
          throw new StateVersionConflictError({ expected: expectedVersion ?? -1, current: STATE_VERSION + 1 });
        },
      },
    });
    const error = await rotateWebhookCommand({ ...BASE, sinkOpts: STDOUT_SINK, deps }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof StateVersionConflictError);
    assert.match(error.message, /state version 4 expected, 5 now\)\. The secret was not rotated; the old one still works\./);
    assert.deepEqual(captured.stdout, []);
  });

  it('rotate refuses with --state-version that does not match, before the rotate call', async () => {
    const deps = makeDeps({ io: makeIo().io });
    await assert.rejects(
      rotateWebhookCommand({ ...BASE, sinkOpts: STDOUT_SINK, pinnedVersion: STATE_VERSION - 1, deps }),
      StateVersionPinError,
    );
    assert.deepEqual(deps.apiCalls, ['version']);
  });

  it('rotate refuses when the server sends no state version, before the rotate call', async () => {
    const deps = makeDeps({ io: makeIo().io, client: { getAppStateVersion: async () => null } });
    await assert.rejects(rotateWebhookCommand({ ...BASE, sinkOpts: STDOUT_SINK, deps }), ServerTooOldForGuardedWritesError);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('update maps a 412 to StateVersionConflictError', async () => {
    const deps = makeDeps({
      io: makeIo().io,
      client: {
        updateWebhookEvents: async () => {
          throw new StateVersionConflictError({ expected: STATE_VERSION, current: STATE_VERSION + 2 });
        },
      },
    });
    await assert.rejects(
      updateWebhookCommand({ appId: 'app_1', webhookId: 'wh_1', events: 'email.sent', isJson: false, deps }),
      /The event list was not changed\./,
    );
  });
});

describe('PigeonClient and the state version', () => {
  const client = new PigeonClient({ baseUrl: 'http://pigeon.test' });

  afterEach(() => mock.restoreAll());

  function stubFetch(response: () => Response): Array<{ url: string; init?: RequestInit }> {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response();
    });
    return calls;
  }

  it('sends If-Match as a quoted version and reads the new version', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ webhook: makeWebhook(), signingSecret: SECRET }), {
          status: 200,
          headers: { 'Pigeon-State-Version': '8' },
        }),
    );
    const result = await client.rotateWebhookSecret({ adminSecret: 'admin', appId: 'app_1', webhookId: 'wh_1', expectedVersion: 7 });
    assert.equal(new Headers(calls[0]?.init?.headers).get('If-Match'), '"7"');
    assert.equal(result.stateVersion, 8);
  });

  it('sends no If-Match on an unguarded call, and reads a missing header as null', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ webhooks: [] }), { status: 200 }));
    const result = await client.listWebhooks({ adminSecret: 'admin', appId: 'app_1' });
    assert.equal(new Headers(calls[0]?.init?.headers).get('If-Match'), null);
    assert.equal(result.stateVersion, null);
  });

  it('maps the 412 body to StateVersionConflictError, also on a call whose answer holds a secret', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'state_version_mismatch', expected: 7, current: 9 }), {
          status: 412,
          headers: { 'Pigeon-State-Version': '9' },
        }),
    );
    await assert.rejects(
      client.rotateWebhookSecret({ adminSecret: 'admin', appId: 'app_1', webhookId: 'wh_1', expectedVersion: 7 }),
      (error: unknown) => error instanceof StateVersionConflictError && error.expected === 7 && error.current === 9,
    );
  });
});

describe('pigeon CLI process exit code on a 412', () => {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let server: Server;
  let baseUrl: string;
  let rotateIfMatch: string | undefined;

  before(async () => {
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ status: 'ok', apiVersion: 1 }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/admin/apps/app_1') {
        response.setHeader('Pigeon-State-Version', '3');
        response.end(JSON.stringify({ app: { id: 'app_1', name: 'x', createdAt: '2026-11-09T00:00:00.000Z' } }));
        return;
      }
      rotateIfMatch = request.headers['if-match'];
      response.statusCode = 412;
      response.setHeader('Pigeon-State-Version', '4');
      response.end(JSON.stringify({ error: 'state_version_mismatch', expected: 3, current: 4 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('webhooks rotate exits 30, prints no secret, and says nothing was rotated', async () => {
    const result = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', cliPath, 'webhooks', 'rotate', 'app_1', 'wh_1', '--secret-stdout'],
      {
        env: {
          ...process.env,
          PIGEON_ADMIN_URL: baseUrl,
          PIGEON_ADMIN_SECRET: 'test-secret',
          NO_PROXY: '127.0.0.1',
          no_proxy: '127.0.0.1',
        },
      },
    ).then(
      () => ({ code: 0, stdout: '', stderr: '' }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? null,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );

    assert.equal(result.code, EXIT_STATE_CONFLICT);
    assert.equal(result.stdout, '');
    assert.equal(rotateIfMatch, '"3"');
    assert.match(result.stderr, /^Error: The app changed while this command ran \(state version 3 expected, 4 now\)/);
  });
});
