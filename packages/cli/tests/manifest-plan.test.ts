import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseManifest } from '../src/lib/manifest.js';
import type { Manifest } from '../src/lib/manifest.js';
import {
  EXIT_CHANGES_NEEDED,
  EXIT_NOT_CHECKED,
  EXIT_OK,
  buildPlan,
  parseOrigin,
  planActions,
  planExitCode,
  unionEvents,
} from '../src/lib/manifest-plan.js';
import type { LiveState, LiveWebhook, Plan } from '../src/lib/manifest-plan.js';
import { observeLiveState, planDisplayRows, planManifestCommand } from '../src/commands/manifest.js';
import {
  APP_ID,
  FULL_MANIFEST,
  ORIGIN,
  TENANT_KEY,
  makeFakeClient,
  makeInSyncInstance,
  makeManifestDeps,
  makeManifestIo,
} from './manifest-test-helpers.js';

function fullManifest(): Manifest {
  const result = parseManifest(FULL_MANIFEST);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.manifest;
}

const USABLE_KEY = { kind: 'usable' } as const;

const DECLARED_EVENTS = ['email.bounced', 'email.complained', 'email.received'];

function hook(overrides: Partial<LiveWebhook> = {}): LiveWebhook {
  return { id: 'wh_1', url: `${ORIGIN}/webhooks/pigeon`, eventTypes: DECLARED_EVENTS, enabled: true, ...overrides };
}

function inSyncLive(overrides: Partial<LiveState> = {}): LiveState {
  return {
    app: { kind: 'found', id: APP_ID },
    domains: { kind: 'read', items: [{ id: 'dom_1', name: 'example.test', isVerified: true }] },
    audiences: { kind: 'read', items: [{ id: 'aud_1', name: 'product-updates' }] },
    webhooks: { kind: 'read', items: [hook()] },
    inboundDomains: { kind: 'read', items: [{ id: 'ind_1', name: 'reply.example.test', enabled: true }] },
    ...overrides,
  };
}

function statuses(plan: Plan): Record<string, string> {
  return Object.fromEntries(
    planDisplayRows({ plan, manifest: fullManifest() }).map((row) => [`${row.section} ${row.item}`, row.status]),
  );
}

describe('buildPlan statuses', () => {
  it('is all ok and exits 0 when the instance matches', () => {
    const plan = buildPlan({ manifest: fullManifest(), live: inSyncLive(), origin: null });
    assert.deepEqual(statuses(plan), {
      'app my-app': 'ok',
      'domain example.test': 'ok',
      'sender noreply@example.test': 'ok',
      'audience product-updates': 'ok',
      'webhook /webhooks/pigeon': 'ok',
      'inbound reply.example.test': 'ok',
    });
    assert.equal(planExitCode(plan), EXIT_OK);
  });

  it('marks an unverified domain, and its sender is not ok', () => {
    const live = inSyncLive({
      domains: { kind: 'read', items: [{ id: 'dom_1', name: 'example.test', isVerified: false }] },
    });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(statuses(plan)['domain example.test'], 'unverified');
    assert.equal(statuses(plan)['sender noreply@example.test'], 'domain-not-ok');
    assert.equal(planExitCode(plan), EXIT_CHANGES_NEEDED);
  });

  it('marks missing domains, audiences, webhooks and inbound domains', () => {
    const live = inSyncLive({
      domains: { kind: 'read', items: [] },
      audiences: { kind: 'read', items: [] },
      webhooks: { kind: 'read', items: [] },
      inboundDomains: { kind: 'read', items: [] },
    });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.deepEqual(statuses(plan), {
      'app my-app': 'ok',
      'domain example.test': 'missing',
      'sender noreply@example.test': 'domain-not-ok',
      'audience product-updates': 'missing',
      'webhook /webhooks/pigeon': 'missing',
      'inbound reply.example.test': 'missing',
    });
    assert.equal(planExitCode(plan), EXIT_CHANGES_NEEDED);
  });

  it('marks events-differ and lists the missing events', () => {
    const live = inSyncLive({ webhooks: { kind: 'read', items: [hook({ eventTypes: ['email.bounced'] })] } });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    const row = plan.webhooks.rows[0];
    assert.equal(row?.status, 'events-differ');
    assert.deepEqual(row?.missingEvents, ['email.complained', 'email.received']);
    const display = planDisplayRows({ plan, manifest: fullManifest() }).find((entry) => entry.section === 'webhook');
    assert.match(display?.detail ?? '', /lacks email\.complained, email\.received/);
  });

  it('shows the [[inbound]] env name in the Env column data, and nothing when it is absent', () => {
    const withEnv = parseManifest(FULL_MANIFEST.replace(
      'domain = "reply.example.test"',
      'domain = "reply.example.test"\nenv = "SUPPORT_REPLY_DOMAIN"',
    ));
    if (!withEnv.ok) throw new Error(JSON.stringify(withEnv.issues));
    const plan = buildPlan({ manifest: withEnv.manifest, live: inSyncLive(), origin: null });
    const row = planDisplayRows({ plan, manifest: withEnv.manifest }).find((entry) => entry.section === 'inbound');
    assert.deepEqual(row?.env, ['SUPPORT_REPLY_DOMAIN']);

    const plain = fullManifest();
    const plainPlan = buildPlan({ manifest: plain, live: inSyncLive(), origin: null });
    const plainRow = planDisplayRows({ plan: plainPlan, manifest: plain }).find((entry) => entry.section === 'inbound');
    assert.deepEqual(plainRow?.env, []);
  });

  it('treats a live * webhook as covering every declared event', () => {
    const live = inSyncLive({ webhooks: { kind: 'read', items: [hook({ eventTypes: ['*'] })] } });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(plan.webhooks.rows[0]?.status, 'ok');
  });

  it('matches webhooks by pathname without --origin and by full URL with it', () => {
    const live = inSyncLive({
      webhooks: { kind: 'read', items: [hook({ url: 'https://staging.example.test/webhooks/pigeon' })] },
    });
    const byPath = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(byPath.webhooks.rows[0]?.status, 'ok');

    const byUrl = buildPlan({ manifest: fullManifest(), live, origin: ORIGIN });
    assert.equal(byUrl.webhooks.rows[0]?.status, 'missing');
    assert.deepEqual(byUrl.webhooks.undeclared, [{ id: 'wh_1', name: 'https://staging.example.test/webhooks/pigeon' }]);
  });

  it('lists items the manifest does not declare as undeclared, without changing the exit code', () => {
    const live = inSyncLive({
      domains: {
        kind: 'read',
        items: [
          { id: 'dom_1', name: 'example.test', isVerified: true },
          { id: 'dom_2', name: 'old.example.test', isVerified: true },
        ],
      },
      audiences: { kind: 'read', items: [{ id: 'aud_1', name: 'product-updates' }, { id: 'aud_2', name: 'legacy' }] },
      webhooks: { kind: 'read', items: [hook(), hook({ id: 'wh_2', url: `${ORIGIN}/other` })] },
      inboundDomains: {
        kind: 'read',
        items: [
          { id: 'ind_1', name: 'reply.example.test', enabled: true },
          { id: 'ind_2', name: 'in.example.test', enabled: true },
        ],
      },
    });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.deepEqual(plan.domains.undeclared, [{ id: 'dom_2', name: 'old.example.test' }]);
    assert.deepEqual(plan.audiences.undeclared, [{ id: 'aud_2', name: 'legacy' }]);
    assert.deepEqual(plan.webhooks.undeclared, [{ id: 'wh_2', name: `${ORIGIN}/other` }]);
    assert.deepEqual(plan.inbound.undeclared, [{ id: 'ind_2', name: 'in.example.test' }]);
    assert.equal(planExitCode(plan), EXIT_OK);
    assert.deepEqual(planActions({ plan, manifest: fullManifest(), context: { hasWebhookSecretSink: true, writeKey: USABLE_KEY } }), []);
  });

  it('turns an unread section into not-checked rows with no undeclared list, and exits 20', () => {
    const live = inSyncLive({ audiences: { kind: 'not-checked', reason: 'no tenant key' } });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(statuses(plan)['audience product-updates'], 'not-checked');
    assert.equal(plan.audiences.notCheckedReason, 'no tenant key');
    assert.deepEqual(plan.audiences.undeclared, []);
    assert.equal(planExitCode(plan), EXIT_NOT_CHECKED);
  });

  it('lets 20 win over 10', () => {
    const live = inSyncLive({
      domains: { kind: 'read', items: [] },
      webhooks: { kind: 'not-checked', reason: 'request failed' },
    });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(statuses(plan)['domain example.test'], 'missing');
    assert.equal(planExitCode(plan), EXIT_NOT_CHECKED);
  });

  it('marks an empty declared section as not-checked when it cannot be read', () => {
    const result = parseManifest('schema = 1\napp = "my-app"\n[env]\napi_key = "A_KEY"\nbase_url = "A_URL"\n');
    if (!result.ok) throw new Error('fixture');
    const live = inSyncLive({ domains: { kind: 'not-checked', reason: 'no tenant key' } });
    const plan = buildPlan({ manifest: result.manifest, live, origin: null });
    assert.equal(planExitCode(plan), EXIT_NOT_CHECKED);
  });
});

describe('observeLiveState', () => {
  it('reads domains and audiences with the admin secret and needs no tenant key', async () => {
    const { client, calls } = makeFakeClient({ instance: makeInSyncInstance() });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: null, deps });

    assert.equal(live.domains.kind, 'read');
    assert.equal(live.audiences.kind, 'read');
    assert.deepEqual(live.domains, { kind: 'read', items: [{ id: 'dom_example.test', name: 'example.test', isVerified: true }] });
    assert.ok(calls.includes('listAppDomains'));
    assert.ok(calls.includes('listAppAudiences'));
    // The admin path never touches the tenant routes or the key check.
    for (const tenantCall of ['listDomains', 'listAudiences', 'listApiKeys']) {
      assert.equal(calls.includes(tenantCall), false, tenantCall);
    }
    const plan = buildPlan({ manifest: fullManifest(), live, origin: parseOrigin(ORIGIN) });
    assert.equal(planExitCode(plan), EXIT_OK);
  });

  it('ignores a given tenant key when the admin lists exist', async () => {
    const { client, calls } = makeFakeClient({ instance: makeInSyncInstance() });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });
    assert.equal(live.domains.kind, 'read');
    assert.equal(calls.includes('listDomains'), false);
  });

  it('falls back to the tenant key on a server without the admin lists', async () => {
    const { client, calls } = makeFakeClient({ instance: makeInSyncInstance(), hasAdminLists: false });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });

    assert.equal(live.domains.kind, 'read');
    assert.equal(live.audiences.kind, 'read');
    assert.ok(calls.includes('listDomains'));
    assert.ok(calls.includes('listAudiences'));
    assert.equal(calls.filter((call) => call === 'listApiKeys').length, 1);
  });

  it('reports domains and audiences as not-checked without a key on a server without the admin lists', async () => {
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), hasAdminLists: false });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: null, deps });
    assert.equal(live.domains.kind, 'not-checked');
    assert.equal(live.audiences.kind, 'not-checked');
    assert.equal(live.webhooks.kind, 'read');
    assert.match(live.domains.kind === 'not-checked' ? live.domains.reason : '', /no admin list.*--key/);

    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });
    assert.equal(statuses(plan)['domain example.test'], 'not-checked');
    assert.equal(statuses(plan)['sender noreply@example.test'], 'not-checked');
    assert.equal(planExitCode(plan), EXIT_NOT_CHECKED);
  });

  it('reports every section as not-checked when the app is missing', async () => {
    const instance = makeInSyncInstance();
    instance.apps = [];
    const { client } = makeFakeClient({ instance });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });
    const plan = buildPlan({ manifest: fullManifest(), live, origin: null });

    assert.equal(plan.app.status, 'missing');
    for (const section of [plan.domains, plan.audiences, plan.webhooks, plan.inbound]) {
      assert.match(section.notCheckedReason ?? '', /does not exist/);
    }
    assert.equal(planExitCode(plan), EXIT_NOT_CHECKED);
  });

  it('refuses a tenant key that belongs to another app on the fallback path', async () => {
    const instance = makeInSyncInstance();
    instance.tenantKeys.set('ske_othr_placeholder', 'app_other');
    const { client } = makeFakeClient({ instance, hasAdminLists: false });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: 'ske_othr_placeholder', deps });
    assert.deepEqual(live.domains, {
      kind: 'not-checked',
      reason: `this server has no admin list for it, and the tenant key is not an active key of app ${APP_ID}`,
    });
  });

  it('does not fall back when an admin list fails for another reason, and never reads it as empty', async () => {
    const { client, calls } = makeFakeClient({ instance: makeInSyncInstance(), failOn: ['listAppDomains'] });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });

    assert.equal(live.domains.kind, 'not-checked');
    assert.match(live.domains.kind === 'not-checked' ? live.domains.reason : '', /request failed.*injected failure/);
    assert.equal(calls.includes('listDomains'), false);
    assert.equal(live.audiences.kind, 'read');
  });

  it('does not take a 404 app_not_found for a missing route', async () => {
    const instance = makeInSyncInstance();
    const { client, calls } = makeFakeClient({ instance });
    // The app is listed by name, then removed before its lists are read.
    const listApps = client.listApps;
    client.listApps = async (args) => {
      const result = await listApps(args);
      instance.apps = [];
      return result;
    };
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });

    assert.equal(live.domains.kind, 'not-checked');
    assert.match(live.domains.kind === 'not-checked' ? live.domains.reason : '', /app_not_found/);
    assert.equal(calls.includes('listDomains'), false);
  });

  it('turns a failed section read into not-checked, never into an empty list', async () => {
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), failOn: ['listWebhooks'] });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    const live = await observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps });
    assert.equal(live.webhooks.kind, 'not-checked');
    assert.match(live.webhooks.kind === 'not-checked' ? live.webhooks.reason : '', /request failed/);
  });

  it('throws when the app list cannot be read', async () => {
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), failOn: ['listApps'] });
    const deps = makeManifestDeps({ client, io: makeManifestIo().io });
    await assert.rejects(observeLiveState({ manifest: fullManifest(), tenantKey: TENANT_KEY, deps }), /injected failure/);
  });
});

describe('planManifestCommand', () => {
  it('exits 0 and prints every row ok on an in-sync instance', async () => {
    const { client, writes } = makeFakeClient({ instance: makeInSyncInstance() });
    const capture = makeManifestIo();
    const code = await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: TENANT_KEY,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(writes, []);
    assert.match(capture.allOutput(), /Result: everything declared is ok \(exit 0\)/);
  });

  it('needs no key: exits 0 on an in-sync instance with the admin lists', async () => {
    const { client, writes } = makeFakeClient({ instance: makeInSyncInstance() });
    const capture = makeManifestIo();
    const code = await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.equal(code, EXIT_OK);
    assert.deepEqual(writes, []);
    assert.equal(capture.allOutput().includes('not checked'), false);
  });

  it('reports a missing domain as missing, exit 10, without a key', async () => {
    const instance = makeInSyncInstance();
    instance.domains = [];
    const { client } = makeFakeClient({ instance });
    const code = await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isJson: false,
      deps: makeManifestDeps({ client, io: makeManifestIo().io }),
    });
    assert.equal(code, EXIT_CHANGES_NEEDED);
  });

  it('prints not-checked sections with their reason and exits 20 without a key on a server without the admin lists', async () => {
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), hasAdminLists: false });
    const capture = makeManifestIo();
    const code = await planManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: undefined,
      isJson: true,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.equal(code, EXIT_NOT_CHECKED);
    const json = JSON.parse(capture.stdout.join('')) as {
      rows: Array<{ section: string; status: string; env: string[] }>;
      notChecked: Array<{ section: string; reason: string }>;
    };
    assert.equal(json.rows.find((row) => row.section === 'domain')?.status, 'not-checked');
    assert.deepEqual(
      json.notChecked.map((entry) => entry.section),
      ['domains', 'audiences'],
    );
    assert.deepEqual(json.rows.find((row) => row.section === 'app')?.env, ['PIGEON_API_KEY', 'PIGEON_BASE_URL']);
    assert.equal(capture.allOutput().includes('admin-secret-placeholder'), false);
  });

  it('prints the [[inbound]] env name in the table and in --json', async () => {
    const text = FULL_MANIFEST.replace(
      'domain = "reply.example.test"',
      'domain = "reply.example.test"\nenv = "SUPPORT_REPLY_DOMAIN"',
    );
    for (const isJson of [false, true]) {
      const { client } = makeFakeClient({ instance: makeInSyncInstance() });
      const capture = makeManifestIo();
      await planManifestCommand({
        source: { path: 'pigeon.toml', text },
        tenantKey: TENANT_KEY,
        origin: ORIGIN,
        isJson,
        deps: makeManifestDeps({ client, io: capture.io }),
      });
      if (!isJson) {
        const line = capture.allOutput().split('\n').find((entry) => entry.includes('reply.example.test'));
        assert.match(line ?? '', /SUPPORT_REPLY_DOMAIN/);
        continue;
      }
      const json = JSON.parse(capture.stdout.join('')) as { rows: Array<{ section: string; env: string[] }> };
      assert.deepEqual(json.rows.find((row) => row.section === 'inbound')?.env, ['SUPPORT_REPLY_DOMAIN']);
    }
  });

  it('exits 1 on an invalid manifest without calling the instance', async () => {
    const { client } = makeFakeClient({ instance: makeInSyncInstance(), failOn: ['listApps'] });
    const capture = makeManifestIo();
    const code = await planManifestCommand({
      source: { path: 'pigeon.toml', text: 'schema = 9\n' },
      tenantKey: null,
      origin: undefined,
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    assert.equal(code, 1);
  });
});

describe('actions and event union', () => {
  it('never drops an event in the union', () => {
    const live = ['email.sent', 'email.opened'];
    const union = unionEvents({ liveEvents: live, declaredEvents: DECLARED_EVENTS });
    assert.deepEqual(union, ['email.sent', 'email.opened', ...DECLARED_EVENTS]);
    assert.deepEqual(unionEvents({ liveEvents: ['email.sent'], declaredEvents: ['*'] }), ['*']);
    assert.deepEqual(unionEvents({ liveEvents: ['*'], declaredEvents: ['email.sent'] }), ['*']);
  });

  it('blocks a webhook create without --origin and without a secret sink', () => {
    const live = inSyncLive({ webhooks: { kind: 'read', items: [] } });
    const noOrigin = planActions({
      plan: buildPlan({ manifest: fullManifest(), live, origin: null }),
      manifest: fullManifest(),
      context: { hasWebhookSecretSink: true, writeKey: USABLE_KEY },
    });
    assert.equal(noOrigin.length, 1);
    assert.equal(noOrigin[0]?.kind, 'blocked');
    assert.match(noOrigin[0]?.kind === 'blocked' ? noOrigin[0].reason : '', /--origin/);

    const noSink = planActions({
      plan: buildPlan({ manifest: fullManifest(), live, origin: ORIGIN }),
      manifest: fullManifest(),
      context: { hasWebhookSecretSink: false, writeKey: USABLE_KEY },
    });
    assert.match(noSink[0]?.kind === 'blocked' ? noSink[0].reason : '', /--vault/);
  });

  it('blocks an events update when several webhooks match the path', () => {
    const live = inSyncLive({
      webhooks: {
        kind: 'read',
        items: [
          hook({ id: 'wh_a', url: 'https://a.example.test/webhooks/pigeon', eventTypes: ['email.sent'] }),
          hook({ id: 'wh_b', url: 'https://b.example.test/webhooks/pigeon', eventTypes: ['email.sent'] }),
        ],
      },
    });
    const actions = planActions({
      plan: buildPlan({ manifest: fullManifest(), live, origin: null }),
      manifest: fullManifest(),
      context: { hasWebhookSecretSink: true, writeKey: USABLE_KEY },
    });
    assert.equal(actions[0]?.kind, 'blocked');
  });

  it('blocks the items of a not-checked section instead of skipping them', () => {
    const live = inSyncLive({ domains: { kind: 'not-checked', reason: 'no tenant key' } });
    const actions = planActions({
      plan: buildPlan({ manifest: fullManifest(), live, origin: null }),
      manifest: fullManifest(),
      context: { hasWebhookSecretSink: true, writeKey: USABLE_KEY },
    });
    assert.deepEqual(actions, [
      { kind: 'blocked', section: 'domains', item: 'example.test', reason: 'not checked: no tenant key' },
    ]);
  });
});

describe('parseOrigin', () => {
  it('accepts a bare origin and drops a trailing slash', () => {
    assert.equal(parseOrigin('https://app.example.test/'), 'https://app.example.test');
  });

  it('refuses a path, another scheme and junk', () => {
    assert.throws(() => parseOrigin('https://app.example.test/hooks'), /no path/);
    assert.throws(() => parseOrigin('ftp://app.example.test'), /https/);
    assert.throws(() => parseOrigin('app'), /not a valid URL/);
  });
});
