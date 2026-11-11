import type { ManifestClient, ManifestDeps, ManifestIo } from '../src/commands/manifest.js';
import type { RunBay } from '../src/lib/bay-vault.js';
import { PigeonHttpError } from '../src/lib/pigeon-client.js';
import { StateVersionConflictError } from '../src/lib/state-version.js';
import type {
  PigeonApiKeyListItem,
  PigeonApp,
  PigeonAudience,
  PigeonDomain,
  PigeonInboundDomain,
  PigeonWebhook,
} from '../src/lib/types.js';
import { makeFakeVault } from './webhook-test-helpers.js';

export const TENANT_KEY = 'ske_test_placeholder';
export const NEW_API_KEY = 'ske_new_placeholder_key_value';
export const WEBHOOK_SECRET = 'whsec_test_placeholder_secret_value';
export const ORIGIN = 'https://app.example.test';
export const APP_ID = 'app_1';

/** A manifest that uses every section. */
export const FULL_MANIFEST = `
schema = 1
app = "my-app"

[env]
api_key  = "PIGEON_API_KEY"
base_url = "PIGEON_BASE_URL"

[[domains]]
name = "example.test"
receives_mail = true

[[senders]]
address = "noreply@example.test"
purpose = "transactional"
env = "MAIL_FROM_ADDRESS"

[[audiences]]
name = "product-updates"
id_env = "PIGEON_AUDIENCE_ID"
description = "Release notes"

[[webhooks]]
path = "/webhooks/pigeon"
events = ["email.bounced", "email.complained", "email.received"]
secret_env = "PIGEON_WEBHOOK_SECRET"

[[inbound]]
domain = "reply.example.test"

[uses]
erase = true
`;

const TIME = '2026-11-09T00:00:00.000Z';

export function makeDomain(overrides: Partial<PigeonDomain> & { name: string }): PigeonDomain {
  return {
    id: `dom_${overrides.name}`,
    region: 'eu-central-1',
    dkimTokens: [],
    spfStatus: 'verified',
    dkimStatus: 'verified',
    dmarcStatus: 'verified',
    mxStatus: 'verified',
    verifiedAt: TIME,
    ...overrides,
  };
}

export function makeLiveWebhook(overrides: Partial<PigeonWebhook> & { url: string }): PigeonWebhook {
  return {
    id: 'wh_1',
    appId: APP_ID,
    eventTypes: ['email.bounced', 'email.complained', 'email.received'],
    enabled: true,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdAt: TIME,
    updatedAt: TIME,
    ...overrides,
  };
}

export interface FakeInstance {
  apps: PigeonApp[];
  apiKeys: PigeonApiKeyListItem[];
  /** Plaintext key -> app id. */
  tenantKeys: Map<string, string>;
  domains: Array<PigeonDomain & { appId: string }>;
  audiences: PigeonAudience[];
  webhooks: PigeonWebhook[];
  inboundDomains: PigeonInboundDomain[];
  /** App id -> state version. A missing entry reads as 0. */
  stateVersions: Map<string, number>;
}

/** Plays a change by another machine: bumps the app's state version, as any configuration write does. */
export function bumpStateVersion(opts: { instance: FakeInstance; appId: string }): number {
  const next = (opts.instance.stateVersions.get(opts.appId) ?? 0) + 1;
  opts.instance.stateVersions.set(opts.appId, next);
  return next;
}

/** An instance where the app exists and everything in FULL_MANIFEST is in sync. */
export function makeInSyncInstance(): FakeInstance {
  return {
    apps: [{ id: APP_ID, name: 'my-app', createdAt: TIME }],
    apiKeys: [{ id: 'key_1', appId: APP_ID, name: 'production', prefix: TENANT_KEY.slice(0, 8), revokedAt: null }],
    tenantKeys: new Map([[TENANT_KEY, APP_ID]]),
    domains: [{ ...makeDomain({ name: 'example.test' }), appId: APP_ID }],
    audiences: [
      { id: 'aud_1', appId: APP_ID, name: 'product-updates', description: null, createdAt: TIME, updatedAt: TIME },
    ],
    webhooks: [makeLiveWebhook({ url: `${ORIGIN}/webhooks/pigeon` })],
    inboundDomains: [
      { id: 'ind_1', appId: APP_ID, name: 'reply.example.test', region: 'eu-central-1', enabled: true, createdAt: TIME, updatedAt: TIME },
    ],
    stateVersions: new Map([[APP_ID, 7]]),
  };
}

export function makeEmptyInstance(): FakeInstance {
  return {
    apps: [],
    apiKeys: [],
    tenantKeys: new Map(),
    domains: [],
    audiences: [],
    webhooks: [],
    inboundDomains: [],
    stateVersions: new Map(),
  };
}

type ClientMethod = keyof ManifestClient;

export interface FakeClient {
  client: ManifestClient;
  /** Every write, in order, as `method:detail`. Reads are not recorded. */
  writes: string[];
  /** Every method called, reads and writes, in order. */
  calls: string[];
  /** The If-Match of every configuration write, in order, as `method:<n>` or `method:none`. */
  ifMatch: string[];
}

function tenantApp(opts: { instance: FakeInstance; tenantKey: string }): string {
  const appId = opts.instance.tenantKeys.get(opts.tenantKey);
  if (appId === undefined) throw new Error('Pigeon API error 401 on GET /v1/domains: invalid api key');
  return appId;
}

/** What an older server answers for a per-app admin route it does not have: a 404 HTML page, no error code. */
export function makeMissingRouteError(path: string): PigeonHttpError {
  return new PigeonHttpError({
    status: 404,
    code: null,
    message: `Pigeon API error 404 on GET ${path}: <!DOCTYPE html><html><body>404</body></html>`,
  });
}

/**
 * An in-memory pigeon. `failOn` makes a method throw the way a failed HTTP
 * call does. New domains start unverified, as on the real service.
 * `hasAdminLists: false` plays an older server: the admin domain and audience
 * lists answer like a route that does not exist.
 */
export function makeFakeClient(opts: {
  instance: FakeInstance;
  failOn?: ClientMethod[];
  hasAdminLists?: boolean;
  /** False plays a server older than the state version: no header on any answer. */
  hasStateVersion?: boolean;
  /** Runs before each configuration write, to play another machine changing the app in between. */
  beforeWrite?: (method: ClientMethod) => void;
}): FakeClient {
  const { instance } = opts;
  const writes: string[] = [];
  const calls: string[] = [];
  const ifMatch: string[] = [];
  const failOn = new Set(opts.failOn ?? []);
  const hasAdminLists = opts.hasAdminLists ?? true;
  const hasStateVersion = opts.hasStateVersion ?? true;
  let counter = 0;

  function guard(method: ClientMethod): void {
    calls.push(method);
    if (failOn.has(method)) throw new Error(`Pigeon API error 500 on ${method}: injected failure`);
  }

  /** The header value a read reports. */
  function versionOf(appId: string): number | null {
    if (!hasStateVersion) return null;
    return instance.stateVersions.get(appId) ?? 0;
  }

  /** What the server does on a configuration write: check If-Match, then bump. Throws the 412. */
  function configWrite(write: { method: ClientMethod; appId: string; expectedVersion: number | undefined }): number | null {
    opts.beforeWrite?.(write.method);
    ifMatch.push(`${write.method}:${write.expectedVersion ?? 'none'}`);
    const current = instance.stateVersions.get(write.appId) ?? 0;
    if (write.expectedVersion !== undefined && write.expectedVersion !== current) {
      throw new StateVersionConflictError({ expected: write.expectedVersion, current });
    }
    const next = bumpStateVersion({ instance, appId: write.appId });
    return hasStateVersion ? next : null;
  }

  function requireAdminList(opts: { method: ClientMethod; appId: string; section: 'domains' | 'audiences' }): void {
    guard(opts.method);
    if (!hasAdminLists) throw makeMissingRouteError(`/v1/admin/apps/${opts.appId}/${opts.section}`);
    if (!instance.apps.some((app) => app.id === opts.appId)) {
      throw new PigeonHttpError({
        status: 404,
        code: 'app_not_found',
        message: `Pigeon API error 404 on GET /v1/admin/apps/${opts.appId}/${opts.section}: {"error":{"code":"app_not_found"}}`,
      });
    }
  }

  const client: ManifestClient = {
    listApps: async () => {
      guard('listApps');
      return { status: 200, apps: instance.apps };
    },
    createApp: async ({ name }) => {
      guard('createApp');
      writes.push(`createApp:${name}`);
      const app = { id: `app_new_${++counter}`, name, createdAt: TIME };
      instance.apps.push(app);
      instance.stateVersions.set(app.id, 0);
      return { app, stateVersion: versionOf(app.id) };
    },
    createApiKey: async ({ appId, name }) => {
      guard('createApiKey');
      writes.push(`createApiKey:${name}`);
      const prefix = NEW_API_KEY.slice(0, 8);
      instance.apiKeys.push({ id: 'key_new', appId, name, prefix, revokedAt: null });
      instance.tenantKeys.set(NEW_API_KEY, appId);
      return { apiKey: { id: 'key_new', appId, name, prefix }, plaintext: NEW_API_KEY };
    },
    listApiKeys: async ({ appId }) => {
      guard('listApiKeys');
      return { apiKeys: instance.apiKeys.filter((key) => key.appId === appId) };
    },
    listDomains: async ({ tenantKey }) => {
      guard('listDomains');
      const appId = tenantApp({ instance, tenantKey });
      const stateVersion = versionOf(appId);
      return { domains: instance.domains.filter((domain) => domain.appId === appId), stateVersion };
    },
    listAppDomains: async ({ appId }) => {
      requireAdminList({ method: 'listAppDomains', appId, section: 'domains' });
      const stateVersion = versionOf(appId);
      return { domains: instance.domains.filter((domain) => domain.appId === appId), stateVersion };
    },
    registerDomain: async ({ tenantKey, domain, expectedVersion }) => {
      guard('registerDomain');
      const appId = tenantApp({ instance, tenantKey });
      const stateVersion = configWrite({ method: 'registerDomain', appId, expectedVersion });
      writes.push(`registerDomain:${domain}`);
      const created = makeDomain({ name: domain, dkimStatus: 'pending', verifiedAt: null });
      instance.domains.push({ ...created, appId });
      return {
        id: created.id,
        domain: created,
        dnsRecords: [{ type: 'TXT', host: `_amazonses.${domain}`, value: '"token"', ttl: 3600 }],
        stateVersion,
      };
    },
    listAudiences: async ({ tenantKey }) => {
      guard('listAudiences');
      const appId = tenantApp({ instance, tenantKey });
      const stateVersion = versionOf(appId);
      return { audiences: instance.audiences.filter((audience) => audience.appId === appId), stateVersion };
    },
    listAppAudiences: async ({ appId }) => {
      requireAdminList({ method: 'listAppAudiences', appId, section: 'audiences' });
      const stateVersion = versionOf(appId);
      return { audiences: instance.audiences.filter((audience) => audience.appId === appId), stateVersion };
    },
    createAudience: async ({ tenantKey, name, description, expectedVersion }) => {
      guard('createAudience');
      const appId = tenantApp({ instance, tenantKey });
      const stateVersion = configWrite({ method: 'createAudience', appId, expectedVersion });
      writes.push(`createAudience:${name}`);
      const audience = { id: `aud_new_${++counter}`, appId, name, description, createdAt: TIME, updatedAt: TIME };
      instance.audiences.push(audience);
      return { audience, stateVersion };
    },
    listWebhooks: async ({ appId }) => {
      guard('listWebhooks');
      const stateVersion = versionOf(appId);
      return { webhooks: instance.webhooks.filter((hook) => hook.appId === appId), stateVersion };
    },
    createWebhook: async ({ appId, url, eventTypes, expectedVersion }) => {
      guard('createWebhook');
      const stateVersion = configWrite({ method: 'createWebhook', appId, expectedVersion });
      writes.push(`createWebhook:${url}:${eventTypes.join(',')}`);
      const webhook = makeLiveWebhook({ id: `wh_new_${++counter}`, appId, url, eventTypes });
      instance.webhooks.push(webhook);
      return { webhook, signingSecret: WEBHOOK_SECRET, stateVersion };
    },
    updateWebhookEvents: async ({ appId, webhookId, eventTypes, expectedVersion }) => {
      guard('updateWebhookEvents');
      const stateVersion = configWrite({ method: 'updateWebhookEvents', appId, expectedVersion });
      writes.push(`updateWebhookEvents:${webhookId}:${eventTypes.join(',')}`);
      const webhook = instance.webhooks.find((hook) => hook.id === webhookId);
      if (webhook === undefined) throw new Error('Pigeon API error 404: webhook not found');
      webhook.eventTypes = eventTypes;
      return { webhook, stateVersion };
    },
    listInboundDomains: async ({ appId }) => {
      guard('listInboundDomains');
      const stateVersion = versionOf(appId);
      return { inboundDomains: instance.inboundDomains.filter((domain) => domain.appId === appId), stateVersion };
    },
    addInboundDomain: async ({ appId, name, expectedVersion }) => {
      guard('addInboundDomain');
      const stateVersion = configWrite({ method: 'addInboundDomain', appId, expectedVersion });
      writes.push(`addInboundDomain:${name}`);
      const inboundDomain = {
        id: `ind_new_${++counter}`,
        appId,
        name,
        region: 'eu-central-1',
        enabled: true,
        createdAt: TIME,
        updatedAt: TIME,
      };
      instance.inboundDomains.push(inboundDomain);
      return { inboundDomain, stateVersion };
    },
  };
  return { client, writes, calls, ifMatch };
}

export interface CapturedManifestIo {
  io: ManifestIo;
  stdout: string[];
  stderr: string[];
  allOutput: () => string;
}

export function makeManifestIo(): CapturedManifestIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      log: (text) => {
        stdout.push(`${text}\n`);
      },
      writeStderr: (text) => {
        stderr.push(`${text}\n`);
      },
    },
    stdout,
    stderr,
    allOutput: () => [...stdout, ...stderr].join(''),
  };
}

export function makeManifestDeps(opts: { client: ManifestClient; io: ManifestIo; runBay?: RunBay }): ManifestDeps {
  return {
    client: opts.client,
    adminSecret: 'admin-secret-placeholder',
    runBay: opts.runBay ?? makeFakeVault().runBay,
    io: opts.io,
    detectMailRouting: async () => ({ inboundMx: [], provider: null, existingSpf: null }),
  };
}
