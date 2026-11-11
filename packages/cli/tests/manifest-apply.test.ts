import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyManifestCommand } from '../src/commands/manifest.js';
import type { ManifestDeps, VaultCliOpts } from '../src/commands/manifest.js';
import { EXIT_CHANGES_NEEDED, EXIT_ERROR, EXIT_OK } from '../src/lib/manifest-plan.js';
import {
  FULL_MANIFEST,
  NEW_API_KEY,
  ORIGIN,
  TENANT_KEY,
  WEBHOOK_SECRET,
  makeEmptyInstance,
  makeFakeClient,
  makeInSyncInstance,
  makeLiveWebhook,
  makeManifestDeps,
  makeManifestIo,
} from './manifest-test-helpers.js';
import type { FakeInstance } from './manifest-test-helpers.js';
import { makeFakeVault, makeFleetDir } from './webhook-test-helpers.js';

const NO_VAULT: VaultCliOpts = { vault: false, vaultEnv: 'production' };

function withVault(fleet: string): VaultCliOpts {
  return { vault: true, vaultPrefix: 'MYAPP_', vaultEnv: 'production', fleet };
}

async function apply(opts: {
  deps: ManifestDeps;
  isYes: boolean;
  tenantKey?: string | null;
  origin?: string;
  vaultOpts?: VaultCliOpts;
  isJson?: boolean;
}): Promise<number> {
  return applyManifestCommand({
    source: { path: 'pigeon.toml', text: FULL_MANIFEST },
    tenantKey: opts.tenantKey === undefined ? TENANT_KEY : opts.tenantKey,
    origin: opts.origin,
    isYes: opts.isYes,
    vaultOpts: opts.vaultOpts ?? NO_VAULT,
    isJson: opts.isJson ?? false,
    deps: opts.deps,
  });
}

/** The app exists with its key, but none of the declared items. */
function makeBareAppInstance(): FakeInstance {
  const instance = makeInSyncInstance();
  instance.domains = [];
  instance.audiences = [];
  instance.webhooks = [];
  instance.inboundDomains = [];
  return instance;
}

describe('manifest apply without --yes', () => {
  it('changes nothing and exits 10 when actions are pending', async () => {
    const { client, writes } = makeFakeClient({ instance: makeEmptyInstance() });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: false, origin: ORIGIN });
    assert.equal(code, EXIT_CHANGES_NEEDED);
    assert.deepEqual(writes, []);
    assert.match(capture.allOutput(), /create app "my-app"/);
    assert.match(capture.allOutput(), /Dry run: nothing was changed/);
  });

  it('exits with the plan code when nothing needs doing', async () => {
    const { client, writes } = makeFakeClient({ instance: makeInSyncInstance() });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: false, origin: ORIGIN });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(writes, []);
  });
});

describe('manifest apply --yes', () => {
  it('creates everything in order for a new app and never prints a secret', async () => {
    const { client, writes } = makeFakeClient({ instance: makeEmptyInstance() });
    const vault = makeFakeVault();
    const capture = makeManifestIo();
    const deps = makeManifestDeps({ client, io: capture.io, runBay: vault.runBay });

    const code = await apply({ deps, isYes: true, tenantKey: null, origin: ORIGIN, vaultOpts: withVault(makeFleetDir()) });

    assert.deepEqual(writes, [
      'createApp:my-app',
      'createApiKey:production',
      'registerDomain:example.test',
      'createAudience:product-updates',
      'addInboundDomain:reply.example.test',
      `createWebhook:${ORIGIN}/webhooks/pigeon:email.bounced,email.complained,email.received`,
    ]);
    assert.equal(vault.secrets.get('MYAPP_PIGEON_API_KEY'), NEW_API_KEY);
    assert.equal(vault.secrets.get('MYAPP_PIGEON_WEBHOOK_SECRET'), WEBHOOK_SECRET);

    const output = capture.allOutput();
    assert.equal(output.includes(NEW_API_KEY), false);
    assert.equal(output.includes(WEBHOOK_SECRET), false);
    assert.match(output, /Set PIGEON_AUDIENCE_ID=aud_new_\d+ in the app/);
    assert.match(output, /_amazonses\.example\.test/);
    // The new domain is unverified until its DNS is published, so the re-plan says changes needed.
    assert.equal(code, EXIT_CHANGES_NEEDED);
    assert.match(output, /domain\s+example\.test\s+unverified/);
  });

  it('performs zero writes on a second run', async () => {
    const instance = makeEmptyInstance();
    const first = makeFakeClient({ instance });
    const vault = makeFakeVault();
    const fleet = makeFleetDir();
    await apply({
      deps: makeManifestDeps({ client: first.client, io: makeManifestIo().io, runBay: vault.runBay }),
      isYes: true,
      tenantKey: null,
      origin: ORIGIN,
      vaultOpts: withVault(fleet),
    });

    const second = makeFakeClient({ instance });
    const vaultCallsBefore = vault.calls.length;
    const code = await apply({
      deps: makeManifestDeps({ client: second.client, io: makeManifestIo().io, runBay: vault.runBay }),
      isYes: true,
      tenantKey: NEW_API_KEY,
      origin: ORIGIN,
      vaultOpts: withVault(fleet),
    });
    assert.deepEqual(second.writes, []);
    assert.equal(vault.calls.length, vaultCallsBefore);
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('performs zero writes and exits 0 on an in-sync instance', async () => {
    const { client, writes } = makeFakeClient({ instance: makeInSyncInstance() });
    const code = await apply({ deps: makeManifestDeps({ client, io: makeManifestIo().io }), isYes: true, origin: ORIGIN });
    assert.deepEqual(writes, []);
    assert.equal(code, EXIT_OK);
  });

  it('blocks a missing webhook without --origin and still applies the rest', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    const capture = makeManifestIo();
    const code = await apply({
      deps: makeManifestDeps({ client, io: capture.io }),
      isYes: true,
      vaultOpts: withVault(makeFleetDir()),
    });
    assert.deepEqual(writes, [
      'registerDomain:example.test',
      'createAudience:product-updates',
      'addInboundDomain:reply.example.test',
    ]);
    assert.match(capture.allOutput(), /BLOCKED webhooks \/webhooks\/pigeon: .*--origin/);
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('blocks a missing webhook without --vault, so no secret is minted', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    const capture = makeManifestIo();
    await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: true, origin: ORIGIN });
    assert.equal(writes.some((write) => write.startsWith('createWebhook')), false);
    assert.match(capture.allOutput(), /BLOCKED webhooks .*--vault/);
  });

  it('updates a webhook to the union of its events and never drops one', async () => {
    const instance = makeInSyncInstance();
    instance.webhooks = [
      makeLiveWebhook({ id: 'wh_1', url: `${ORIGIN}/webhooks/pigeon`, eventTypes: ['email.sent', 'email.bounced'] }),
    ];
    const { client, writes } = makeFakeClient({ instance });
    const code = await apply({ deps: makeManifestDeps({ client, io: makeManifestIo().io }), isYes: true });
    assert.deepEqual(writes, ['updateWebhookEvents:wh_1:email.sent,email.bounced,email.complained,email.received']);
    assert.deepEqual(instance.webhooks[0]?.eventTypes, ['email.sent', 'email.bounced', 'email.complained', 'email.received']);
    assert.equal(code, EXIT_OK);
  });

  it('stops at the first failed write and reports what ran', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance(), failOn: ['createAudience'] });
    const capture = makeManifestIo();
    const code = await apply({
      deps: makeManifestDeps({ client, io: capture.io }),
      isYes: true,
      origin: ORIGIN,
      vaultOpts: withVault(makeFleetDir()),
    });
    assert.equal(code, EXIT_ERROR);
    assert.deepEqual(writes, ['registerDomain:example.test']);
    const stderr = capture.stderr.join('');
    assert.match(stderr, /Stopped at the first failed write/);
    assert.match(stderr, /done: register sending domain example\.test/);
    assert.match(stderr, /failed: create audience "product-updates"/);
    assert.match(stderr, /not-run: add inbound domain reply\.example\.test/);
    assert.match(stderr, /not-run: create webhook/);
  });

  it('keeps the webhook secret out of the output when the vault write fails', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    const vault = makeFakeVault({ failSet: true });
    const capture = makeManifestIo();
    const code = await apply({
      deps: makeManifestDeps({ client, io: capture.io, runBay: vault.runBay }),
      isYes: true,
      origin: ORIGIN,
      vaultOpts: withVault(makeFleetDir()),
    });
    assert.equal(code, EXIT_ERROR);
    assert.ok(writes.some((write) => write.startsWith('createWebhook')));
    const output = capture.allOutput();
    assert.equal(output.includes(WEBHOOK_SECRET), false);
    assert.match(output, /pigeon webhooks rotate app_1 wh_new_\d+ --vault MYAPP_PIGEON_WEBHOOK_SECRET/);
  });

  it('refuses a taken vault name before any write', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    const vault = makeFakeVault({ existing: { MYAPP_PIGEON_WEBHOOK_SECRET: 'old-placeholder' } });
    await assert.rejects(
      apply({
        deps: makeManifestDeps({ client, io: makeManifestIo().io, runBay: vault.runBay }),
        isYes: true,
        origin: ORIGIN,
        vaultOpts: withVault(makeFleetDir()),
      }),
      /already holds MYAPP_PIGEON_WEBHOOK_SECRET/,
    );
    assert.deepEqual(writes, []);
  });

  it('prints the new API key once without --vault, as onboard does', async () => {
    const instance = makeEmptyInstance();
    const { client } = makeFakeClient({ instance });
    const capture = makeManifestIo();
    await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: true, tenantKey: null, origin: ORIGIN });
    const output = capture.allOutput();
    assert.equal(output.split(NEW_API_KEY).length - 1, 1);
    assert.match(output, /STORE THIS KEY NOW/);
  });

  it('refuses vault flags without --vault', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    await assert.rejects(
      apply({
        deps: makeManifestDeps({ client, io: makeManifestIo().io }),
        isYes: true,
        vaultOpts: { vault: false, vaultPrefix: 'X_', vaultEnv: 'production' },
      }),
      /--vault-prefix only works with --vault/,
    );
    assert.deepEqual(writes, []);
  });
});

describe('manifest apply and the tenant key', () => {
  it('blocks a missing domain and audience without a key, naming --key, and still applies the rest', async () => {
    const { client, writes, calls } = makeFakeClient({ instance: makeBareAppInstance() });
    const capture = makeManifestIo();
    const code = await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: true, tenantKey: null, origin: ORIGIN });

    assert.deepEqual(writes, ['addInboundDomain:reply.example.test']);
    assert.match(capture.allOutput(), /BLOCKED domains example\.test: .*--key/);
    assert.match(capture.allOutput(), /BLOCKED audiences product-updates: .*--key/);
    assert.equal(calls.includes('registerDomain'), false);
    assert.equal(calls.includes('createAudience'), false);
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('shows the blocked domain in a dry run without --yes', async () => {
    const { client, writes } = makeFakeClient({ instance: makeBareAppInstance() });
    const capture = makeManifestIo();
    await apply({ deps: makeManifestDeps({ client, io: capture.io }), isYes: false, tenantKey: null, origin: ORIGIN });
    assert.deepEqual(writes, []);
    assert.match(capture.allOutput(), /BLOCKED domains example\.test: .*--key/);
  });

  it('does not ask for a key when no domain and no audience needs creating', async () => {
    const instance = makeInSyncInstance();
    instance.webhooks = [];
    const { client, writes, calls } = makeFakeClient({ instance });
    const capture = makeManifestIo();
    const code = await apply({
      deps: makeManifestDeps({ client, io: capture.io }),
      isYes: true,
      tenantKey: null,
      origin: ORIGIN,
      vaultOpts: withVault(makeFleetDir()),
    });

    assert.deepEqual(writes, [`createWebhook:${ORIGIN}/webhooks/pigeon:email.bounced,email.complained,email.received`]);
    assert.equal(capture.allOutput().includes('--key'), false);
    assert.equal(calls.includes('listApiKeys'), false);
    assert.equal(code, EXIT_OK);
  });

  it('registers the domain and creates the audience with the key of the app, reading through the admin lists', async () => {
    const { client, writes, calls } = makeFakeClient({ instance: makeBareAppInstance() });
    const code = await apply({
      deps: makeManifestDeps({ client, io: makeManifestIo().io }),
      isYes: true,
      origin: ORIGIN,
    });
    assert.deepEqual(writes, [
      'registerDomain:example.test',
      'createAudience:product-updates',
      'addInboundDomain:reply.example.test',
    ]);
    assert.equal(calls.includes('listDomains'), false);
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('blocks the writes when the key belongs to another app, though the admin lists read fine', async () => {
    const instance = makeBareAppInstance();
    instance.tenantKeys.set('ske_othr_placeholder', 'app_other');
    const { client, writes } = makeFakeClient({ instance });
    const capture = makeManifestIo();
    await apply({
      deps: makeManifestDeps({ client, io: capture.io }),
      isYes: true,
      tenantKey: 'ske_othr_placeholder',
      origin: ORIGIN,
    });
    assert.deepEqual(writes, ['addInboundDomain:reply.example.test']);
    assert.match(capture.allOutput(), /BLOCKED domains example\.test: .*not an active key of app app_1/);
  });

  it('keeps working against a server without the admin lists', async () => {
    const { client, writes, calls } = makeFakeClient({ instance: makeBareAppInstance(), hasAdminLists: false });
    await apply({ deps: makeManifestDeps({ client, io: makeManifestIo().io }), isYes: true, origin: ORIGIN });
    assert.deepEqual(writes, [
      'registerDomain:example.test',
      'createAudience:product-updates',
      'addInboundDomain:reply.example.test',
    ]);
    assert.ok(calls.includes('listDomains'));
  });
});
