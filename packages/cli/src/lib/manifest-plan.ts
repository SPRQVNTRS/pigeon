import { ALL_EVENTS } from './webhook-events.js';
import type {
  Manifest,
  ManifestAudience,
  ManifestDomain,
  ManifestInbound,
  ManifestSender,
  ManifestWebhook,
} from './manifest.js';

/**
 * Pure planning: (manifest, observed live state) -> plan -> ordered actions.
 * All status logic lives here. The command layer only fetches and renders.
 *
 * Hard rule: a section that could not be read is `not-checked` with its
 * reason. It never renders as `ok` and never as an empty in-sync list.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CHANGES_NEEDED = 10;
export const EXIT_NOT_CHECKED = 20;

export type PlanExitCode = typeof EXIT_OK | typeof EXIT_CHANGES_NEEDED | typeof EXIT_NOT_CHECKED;

// ---------------------------------------------------------------------------
// Observed live state
// ---------------------------------------------------------------------------

export interface LiveDomain {
  id: string;
  name: string;
  /** DKIM verified: the check pigeon's send route applies before it sends. */
  isVerified: boolean;
}

export interface LiveAudience {
  id: string;
  name: string;
}

export interface LiveWebhook {
  id: string;
  url: string;
  /** Null on the server means every event; the caller maps it to `['*']`. */
  eventTypes: string[];
  enabled: boolean;
}

export interface LiveInboundDomain {
  id: string;
  name: string;
  enabled: boolean;
}

/** A section was read, or it could not be read and says why. */
export type Observed<T> = { kind: 'read'; items: T[] } | { kind: 'not-checked'; reason: string };

export type LiveApp =
  | { kind: 'found'; id: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; ids: string[] };

export interface LiveState {
  app: LiveApp;
  domains: Observed<LiveDomain>;
  audiences: Observed<LiveAudience>;
  webhooks: Observed<LiveWebhook>;
  inboundDomains: Observed<LiveInboundDomain>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type AppStatus = 'ok' | 'missing' | 'ambiguous';
export type DomainStatus = 'ok' | 'unverified' | 'missing' | 'not-checked';
export type SenderStatus = 'ok' | 'domain-not-ok' | 'not-checked';
export type PresenceStatus = 'ok' | 'missing' | 'not-checked';
export type WebhookStatus = 'ok' | 'events-differ' | 'missing' | 'not-checked';

export interface AppRow {
  name: string;
  status: AppStatus;
  id: string | null;
  duplicateIds: string[];
}

export interface DomainRow {
  declared: ManifestDomain;
  status: DomainStatus;
  liveId: string | null;
}

export interface SenderRow {
  declared: ManifestSender;
  status: SenderStatus;
  domainStatus: DomainStatus;
}

export interface AudienceRow {
  declared: ManifestAudience;
  status: PresenceStatus;
  liveId: string | null;
}

export interface WebhookRow {
  declared: ManifestWebhook;
  status: WebhookStatus;
  /** Live webhooks that match the declared path (or full URL with --origin). */
  matches: LiveWebhook[];
  /** Declared events the best match lacks. Empty unless `events-differ`. */
  missingEvents: string[];
}

export interface InboundRow {
  declared: ManifestInbound;
  status: PresenceStatus;
  liveId: string | null;
  isEnabled: boolean | null;
}

export interface UndeclaredItem {
  id: string;
  name: string;
}

export interface SectionPlan<Row> {
  rows: Row[];
  undeclared: UndeclaredItem[];
  /** Why the section could not be read. Null when it was read. */
  notCheckedReason: string | null;
}

export type SectionName = 'domains' | 'audiences' | 'webhooks' | 'inbound';

export interface Plan {
  app: AppRow;
  domains: SectionPlan<DomainRow>;
  senders: SenderRow[];
  audiences: SectionPlan<AudienceRow>;
  webhooks: SectionPlan<WebhookRow>;
  inbound: SectionPlan<InboundRow>;
  /** Normalised `https://host`, or null when --origin was not given. */
  origin: string | null;
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

function planApp(opts: { name: string; app: LiveApp }): AppRow {
  const { app, name } = opts;
  switch (app.kind) {
    case 'found':
      return { name, status: 'ok', id: app.id, duplicateIds: [] };
    case 'missing':
      return { name, status: 'missing', id: null, duplicateIds: [] };
    case 'ambiguous':
      return { name, status: 'ambiguous', id: null, duplicateIds: app.ids };
    default: {
      const unreachable: never = app;
      throw new Error(`Unknown app state: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Builds rows for a section; an unread section turns every row into `not-checked`. */
function planSection<Declared, Live extends { id: string }, Row>(opts: {
  declared: Declared[];
  observed: Observed<Live>;
  notCheckedRow: (declared: Declared) => Row;
  readRow: (declared: Declared, live: Live[]) => Row;
  isDeclared: (live: Live) => boolean;
  liveName: (live: Live) => string;
}): SectionPlan<Row> {
  const { observed } = opts;
  if (observed.kind === 'not-checked') {
    return {
      rows: opts.declared.map(opts.notCheckedRow),
      undeclared: [],
      notCheckedReason: observed.reason,
    };
  }
  return {
    rows: opts.declared.map((declared) => opts.readRow(declared, observed.items)),
    undeclared: observed.items
      .filter((live) => !opts.isDeclared(live))
      .map((live) => ({ id: live.id, name: opts.liveName(live) })),
    notCheckedReason: null,
  };
}

function planDomains(opts: { manifest: Manifest; observed: Observed<LiveDomain> }): SectionPlan<DomainRow> {
  const declaredNames = new Set(opts.manifest.domains.map((domain) => domain.name));
  return planSection<ManifestDomain, LiveDomain, DomainRow>({
    declared: opts.manifest.domains,
    observed: opts.observed,
    notCheckedRow: (declared) => ({ declared, status: 'not-checked', liveId: null }),
    readRow: (declared, live) => {
      const match = live.find((domain) => normaliseName(domain.name) === declared.name);
      if (match === undefined) return { declared, status: 'missing', liveId: null };
      return { declared, status: match.isVerified ? 'ok' : 'unverified', liveId: match.id };
    },
    isDeclared: (live) => declaredNames.has(normaliseName(live.name)),
    liveName: (live) => live.name,
  });
}

function senderDomain(address: string): string {
  return normaliseName(address.slice(address.lastIndexOf('@') + 1));
}

function planSenders(opts: { manifest: Manifest; domains: SectionPlan<DomainRow> }): SenderRow[] {
  return opts.manifest.senders.map((declared) => {
    const domainRow = opts.domains.rows.find((row) => row.declared.name === senderDomain(declared.address));
    const domainStatus: DomainStatus = domainRow?.status ?? 'missing';
    if (domainStatus === 'ok') return { declared, status: 'ok', domainStatus };
    if (domainStatus === 'not-checked') return { declared, status: 'not-checked', domainStatus };
    return { declared, status: 'domain-not-ok', domainStatus };
  });
}

function planAudiences(opts: { manifest: Manifest; observed: Observed<LiveAudience> }): SectionPlan<AudienceRow> {
  const declaredNames = new Set(opts.manifest.audiences.map((audience) => audience.name));
  return planSection<ManifestAudience, LiveAudience, AudienceRow>({
    declared: opts.manifest.audiences,
    observed: opts.observed,
    notCheckedRow: (declared) => ({ declared, status: 'not-checked', liveId: null }),
    readRow: (declared, live) => {
      const match = live.find((audience) => audience.name === declared.name);
      if (match === undefined) return { declared, status: 'missing', liveId: null };
      return { declared, status: 'ok', liveId: match.id };
    },
    isDeclared: (live) => declaredNames.has(live.name),
    liveName: (live) => live.name,
  });
}

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** The full URL apply creates for a declared path. */
export function webhookUrl(opts: { origin: string; path: string }): string {
  return `${opts.origin}${opts.path}`;
}

/** With an origin the full URL must match exactly; without one the pathname must. */
export function webhookMatches(opts: { live: LiveWebhook; path: string; origin: string | null }): boolean {
  if (opts.origin !== null) return opts.live.url === webhookUrl({ origin: opts.origin, path: opts.path });
  return pathnameOf(opts.live.url) === opts.path;
}

function coversEvent(opts: { liveEvents: string[]; event: string }): boolean {
  return opts.liveEvents.includes(ALL_EVENTS) || opts.liveEvents.includes(opts.event);
}

export function missingEvents(opts: { liveEvents: string[]; declaredEvents: string[] }): string[] {
  return opts.declaredEvents.filter((event) => !coversEvent({ liveEvents: opts.liveEvents, event }));
}

/**
 * The event list after adding the declared events. Every live event stays.
 * `*` covers every type and must stand alone, so a union with `*` is `*`.
 */
export function unionEvents(opts: { liveEvents: string[]; declaredEvents: string[] }): string[] {
  const all = [...opts.liveEvents, ...opts.declaredEvents];
  if (all.includes(ALL_EVENTS)) return [ALL_EVENTS];
  return [...new Set(all)];
}

function planWebhookRow(opts: { declared: ManifestWebhook; live: LiveWebhook[]; origin: string | null }): WebhookRow {
  const { declared } = opts;
  const matches = opts.live.filter((live) => webhookMatches({ live, path: declared.path, origin: opts.origin }));
  if (matches.length === 0) return { declared, status: 'missing', matches, missingEvents: [] };

  const lacking = matches.map((live) => missingEvents({ liveEvents: live.eventTypes, declaredEvents: declared.events }));
  if (lacking.some((list) => list.length === 0)) return { declared, status: 'ok', matches, missingEvents: [] };

  const fewest = lacking.reduce((best, list) => (list.length < best.length ? list : best));
  return { declared, status: 'events-differ', matches, missingEvents: fewest };
}

function planWebhooks(opts: {
  manifest: Manifest;
  observed: Observed<LiveWebhook>;
  origin: string | null;
}): SectionPlan<WebhookRow> {
  const declared = opts.manifest.webhooks;
  return planSection<ManifestWebhook, LiveWebhook, WebhookRow>({
    declared,
    observed: opts.observed,
    notCheckedRow: (webhook) => ({ declared: webhook, status: 'not-checked', matches: [], missingEvents: [] }),
    readRow: (webhook, live) => planWebhookRow({ declared: webhook, live, origin: opts.origin }),
    isDeclared: (live) => declared.some((webhook) => webhookMatches({ live, path: webhook.path, origin: opts.origin })),
    liveName: (live) => live.url,
  });
}

function planInbound(opts: { manifest: Manifest; observed: Observed<LiveInboundDomain> }): SectionPlan<InboundRow> {
  const declaredNames = new Set(opts.manifest.inbound.map((entry) => entry.domain));
  return planSection<ManifestInbound, LiveInboundDomain, InboundRow>({
    declared: opts.manifest.inbound,
    observed: opts.observed,
    notCheckedRow: (declared) => ({ declared, status: 'not-checked', liveId: null, isEnabled: null }),
    readRow: (declared, live) => {
      const match = live.find((domain) => normaliseName(domain.name) === declared.domain);
      if (match === undefined) return { declared, status: 'missing', liveId: null, isEnabled: null };
      return { declared, status: 'ok', liveId: match.id, isEnabled: match.enabled };
    },
    isDeclared: (live) => declaredNames.has(normaliseName(live.name)),
    liveName: (live) => live.name,
  });
}

/**
 * Validates `--origin` and returns it without a trailing slash.
 * Throws before any API call on anything but a bare http(s) origin.
 */
export function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--origin is not a valid URL: ${raw}. Pass an origin such as https://app.example.com.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`--origin must use https (or http): ${raw}.`);
  }
  const hasExtra = url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '';
  if (hasExtra) {
    throw new Error(`--origin takes a scheme and host only, no path: ${raw}. The manifest holds the path.`);
  }
  return url.origin;
}

export function buildPlan(opts: { manifest: Manifest; live: LiveState; origin: string | null }): Plan {
  const { manifest, live } = opts;
  const domains = planDomains({ manifest, observed: live.domains });
  return {
    app: planApp({ name: manifest.app, app: live.app }),
    domains,
    senders: planSenders({ manifest, domains }),
    audiences: planAudiences({ manifest, observed: live.audiences }),
    webhooks: planWebhooks({ manifest, observed: live.webhooks, origin: opts.origin }),
    inbound: planInbound({ manifest, observed: live.inboundDomains }),
    origin: opts.origin,
  };
}

/** Every section that could not be read, with its reason. */
export function notCheckedSections(plan: Plan): Array<{ section: SectionName; reason: string }> {
  const sections: Array<{ section: SectionName; reason: string | null }> = [
    { section: 'domains', reason: plan.domains.notCheckedReason },
    { section: 'audiences', reason: plan.audiences.notCheckedReason },
    { section: 'webhooks', reason: plan.webhooks.notCheckedReason },
    { section: 'inbound', reason: plan.inbound.notCheckedReason },
  ];
  return sections.flatMap(({ section, reason }) => (reason === null ? [] : [{ section, reason }]));
}

function allDeclaredStatuses(plan: Plan): string[] {
  return [
    plan.app.status,
    ...plan.domains.rows.map((row) => row.status),
    ...plan.senders.map((row) => row.status),
    ...plan.audiences.rows.map((row) => row.status),
    ...plan.webhooks.rows.map((row) => row.status),
    ...plan.inbound.rows.map((row) => row.status),
  ];
}

/** 20 when any section was not checked (wins over 10), 10 when anything declared is not `ok`, else 0. */
export function planExitCode(plan: Plan): PlanExitCode {
  if (notCheckedSections(plan).length > 0) return EXIT_NOT_CHECKED;
  if (allDeclaredStatuses(plan).some((status) => status !== 'ok')) return EXIT_CHANGES_NEEDED;
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BlockedSection = 'app' | SectionName;

export type ManifestAction =
  | { kind: 'create-app'; name: string }
  | { kind: 'register-domain'; name: string; receivesMail: boolean }
  | { kind: 'create-audience'; name: string; description: string | null; idEnv: string | null }
  | { kind: 'add-inbound-domain'; name: string }
  | { kind: 'create-webhook'; path: string; url: string; events: string[]; secretEnv: string }
  | {
      kind: 'update-webhook-events';
      webhookId: string;
      url: string;
      events: string[];
      addedEvents: string[];
    }
  | { kind: 'blocked'; section: BlockedSection; item: string; reason: string };

export type ExecutableAction = Exclude<ManifestAction, { kind: 'blocked' }>;

/**
 * Whether a tenant key can write to the app. Registering a domain and creating
 * an audience are tenant routes, so they need a key that belongs to the app.
 */
export type WriteKeyStatus = { kind: 'usable' } | { kind: 'unusable'; reason: string };

export interface ActionContext {
  /** True when a secret sink (--vault) is set for new webhook signing secrets. */
  hasWebhookSecretSink: boolean;
  /** Only read for an app that already exists. A new app mints its own key. */
  writeKey: WriteKeyStatus;
}

/** True when an existing app has a declared domain or audience that apply would have to create. */
export function needsTenantKeyForWrites(plan: Plan): boolean {
  if (plan.app.status !== 'ok') return false;
  const isMissing = (row: { status: string }): boolean => row.status === 'missing';
  return plan.domains.rows.some(isMissing) || plan.audiences.rows.some(isMissing);
}

export function isExecutable(action: ManifestAction): action is ExecutableAction {
  return action.kind !== 'blocked';
}

function webhookCreateAction(opts: { webhook: ManifestWebhook; origin: string | null; context: ActionContext }): ManifestAction {
  const { webhook } = opts;
  if (opts.origin === null) {
    return {
      kind: 'blocked',
      section: 'webhooks',
      item: webhook.path,
      reason: 'creating a webhook needs the full URL. Pass --origin <https://host>.',
    };
  }
  if (!opts.context.hasWebhookSecretSink) {
    return {
      kind: 'blocked',
      section: 'webhooks',
      item: webhook.path,
      reason: 'the signing secret is shown once and needs a sink. Pass --vault.',
    };
  }
  return {
    kind: 'create-webhook',
    path: webhook.path,
    url: webhookUrl({ origin: opts.origin, path: webhook.path }),
    events: webhook.events,
    secretEnv: webhook.secretEnv,
  };
}

function blockedForWriteKey(opts: {
  section: 'domains' | 'audiences';
  item: string;
  writeKey: Extract<WriteKeyStatus, { kind: 'unusable' }>;
}): ManifestAction {
  return {
    kind: 'blocked',
    section: opts.section,
    item: opts.item,
    reason: `creating it needs a tenant key of this app. ${opts.writeKey.reason}`,
  };
}

function registerDomainAction(opts: { domain: ManifestDomain; writeKey: WriteKeyStatus }): ManifestAction {
  const { domain, writeKey } = opts;
  if (writeKey.kind === 'unusable') return blockedForWriteKey({ section: 'domains', item: domain.name, writeKey });
  return { kind: 'register-domain', name: domain.name, receivesMail: domain.receivesMail };
}

function createAudienceAction(opts: { audience: ManifestAudience; writeKey: WriteKeyStatus }): ManifestAction {
  const { audience, writeKey } = opts;
  if (writeKey.kind === 'unusable') return blockedForWriteKey({ section: 'audiences', item: audience.name, writeKey });
  return { kind: 'create-audience', name: audience.name, description: audience.description, idEnv: audience.idEnv };
}

/** A new app has nothing yet, so every declared item becomes a create. */
function actionsForNewApp(opts: { manifest: Manifest; origin: string | null; context: ActionContext }): ManifestAction[] {
  const { manifest } = opts;
  return [
    { kind: 'create-app', name: manifest.app },
    ...manifest.domains.map((domain): ManifestAction => ({
      kind: 'register-domain',
      name: domain.name,
      receivesMail: domain.receivesMail,
    })),
    ...manifest.audiences.map((audience): ManifestAction => ({
      kind: 'create-audience',
      name: audience.name,
      description: audience.description,
      idEnv: audience.idEnv,
    })),
    ...manifest.inbound.map((entry): ManifestAction => ({ kind: 'add-inbound-domain', name: entry.domain })),
    ...manifest.webhooks.map((webhook) => webhookCreateAction({ webhook, origin: opts.origin, context: opts.context })),
  ];
}

function blockedForSection(opts: { section: SectionName; items: string[]; reason: string | null }): ManifestAction[] {
  if (opts.reason === null) return [];
  const reason = opts.reason;
  return opts.items.map((item) => ({ kind: 'blocked', section: opts.section, item, reason: `not checked: ${reason}` }));
}

function webhookActions(opts: { plan: Plan; context: ActionContext }): ManifestAction[] {
  const { plan } = opts;
  return plan.webhooks.rows.flatMap((row): ManifestAction[] => {
    switch (row.status) {
      case 'ok':
      case 'not-checked':
        return [];
      case 'missing':
        return [webhookCreateAction({ webhook: row.declared, origin: plan.origin, context: opts.context })];
      case 'events-differ':
        return [webhookUpdateAction(row)];
      default: {
        const unreachable: never = row.status;
        throw new Error(`Unknown webhook status: ${String(unreachable)}`);
      }
    }
  });
}

function webhookUpdateAction(row: WebhookRow): ManifestAction {
  const [only, ...others] = row.matches;
  if (only === undefined) throw new Error(`Webhook ${row.declared.path} has no match to update.`);
  if (others.length > 0) {
    return {
      kind: 'blocked',
      section: 'webhooks',
      item: row.declared.path,
      reason: `${row.matches.length} webhooks match this path. Pass --origin to pick one.`,
    };
  }
  const events = unionEvents({ liveEvents: only.eventTypes, declaredEvents: row.declared.events });
  return {
    kind: 'update-webhook-events',
    webhookId: only.id,
    url: only.url,
    events,
    addedEvents: events.filter((event) => !only.eventTypes.includes(event)),
  };
}

/**
 * The ordered, additive action list. Never a delete, never a removed event,
 * never a rotated secret, never an `undeclared` item.
 * Order: app, domains, audiences, inbound domains, new webhooks, webhook updates.
 */
export function planActions(opts: { plan: Plan; manifest: Manifest; context: ActionContext }): ManifestAction[] {
  const { plan, manifest, context } = opts;

  switch (plan.app.status) {
    case 'missing':
      return actionsForNewApp({ manifest, origin: plan.origin, context });
    case 'ambiguous':
      return [
        {
          kind: 'blocked',
          section: 'app',
          item: plan.app.name,
          reason: `${plan.app.duplicateIds.length} apps share this name (${plan.app.duplicateIds.join(', ')}). Resolve it by hand.`,
        },
      ];
    case 'ok':
      break;
    default: {
      const unreachable: never = plan.app.status;
      throw new Error(`Unknown app status: ${String(unreachable)}`);
    }
  }

  const { writeKey } = context;
  const domainActions = plan.domains.rows
    .filter((row) => row.status === 'missing')
    .map((row) => registerDomainAction({ domain: row.declared, writeKey }));
  const audienceActions = plan.audiences.rows
    .filter((row) => row.status === 'missing')
    .map((row) => createAudienceAction({ audience: row.declared, writeKey }));
  const inboundActions = plan.inbound.rows
    .filter((row) => row.status === 'missing')
    .map((row): ManifestAction => ({ kind: 'add-inbound-domain', name: row.declared.domain }));
  const webhookList = webhookActions({ plan, context });

  return [
    ...blockedForSection({
      section: 'domains',
      items: plan.domains.rows.map((row) => row.declared.name),
      reason: plan.domains.notCheckedReason,
    }),
    ...domainActions,
    ...blockedForSection({
      section: 'audiences',
      items: plan.audiences.rows.map((row) => row.declared.name),
      reason: plan.audiences.notCheckedReason,
    }),
    ...audienceActions,
    ...blockedForSection({
      section: 'inbound',
      items: plan.inbound.rows.map((row) => row.declared.domain),
      reason: plan.inbound.notCheckedReason,
    }),
    ...inboundActions,
    ...blockedForSection({
      section: 'webhooks',
      items: plan.webhooks.rows.map((row) => row.declared.path),
      reason: plan.webhooks.notCheckedReason,
    }),
    ...webhookList.filter((action) => action.kind !== 'update-webhook-events'),
    ...webhookList.filter((action) => action.kind === 'update-webhook-events'),
  ];
}

/** Pigeon stores the first 8 characters of each key as its prefix. */
const TENANT_KEY_PREFIX_LENGTH = 8;

/** True when the API key prefix belongs to an unrevoked key of the app. */
export function isTenantKeyOwnedByApp(opts: {
  tenantKey: string;
  appKeys: Array<{ prefix: string; revokedAt: string | null }>;
}): boolean {
  const prefix = opts.tenantKey.slice(0, TENANT_KEY_PREFIX_LENGTH);
  return opts.appKeys.some((key) => key.prefix === prefix && key.revokedAt === null);
}
