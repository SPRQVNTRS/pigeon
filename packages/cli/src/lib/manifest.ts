import { TomlError, parse } from 'smol-toml';
import { ALL_EVENTS, WEBHOOK_EVENT_TYPES } from './webhook-events.js';

/**
 * `pigeon.toml`, schema 1: what a consumer app needs from pigeon.
 * It declares needs only. It never holds an instance id, an instance URL or a
 * secret value; the `env` fields hold env var NAMES.
 *
 * Pure: takes the file text, returns a typed manifest or every issue found.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestDomain {
  name: string;
  receivesMail: boolean;
}

export interface ManifestSender {
  address: string;
  purpose: string;
  env: string | null;
}

export interface ManifestAudience {
  name: string;
  idEnv: string | null;
  description: string | null;
}

export interface ManifestWebhook {
  path: string;
  events: string[];
  secretEnv: string;
}

export interface ManifestInbound {
  domain: string;
  env: string | null;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA_VERSION;
  app: string;
  env: { apiKey: string; baseUrl: string };
  domains: ManifestDomain[];
  senders: ManifestSender[];
  audiences: ManifestAudience[];
  webhooks: ManifestWebhook[];
  inbound: ManifestInbound[];
  uses: { erase: boolean };
}

/** One problem, with the TOML key path it belongs to (`domains[0].name`). */
export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; issues: ManifestIssue[] };

type TomlRecord = Record<string, unknown>;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS_PATTERN = /^[^\s@]+@([^\s@]+)$/;
const SECRET_PREFIX_PATTERN = /^(ske_|whsec_|sk[-_]|pk_|rk_|ghp_|gho_|github_pat_|xox[abp]-|AKIA|ASIA)/;
const MAX_AUDIENCE_NAME_LENGTH = 255;
const KNOWN_EVENTS: ReadonlySet<string> = new Set([...WEBHOOK_EVENT_TYPES, ALL_EVENTS]);
const EVENT_LIST = [...KNOWN_EVENTS].join(', ');

const TOP_LEVEL_KEYS = ['schema', 'app', 'env', 'domains', 'senders', 'audiences', 'webhooks', 'inbound', 'uses'];
const ENV_KEYS = ['api_key', 'base_url'];
const DOMAIN_KEYS = ['name', 'receives_mail'];
const SENDER_KEYS = ['address', 'purpose', 'env'];
const AUDIENCE_KEYS = ['name', 'id_env', 'description'];
const WEBHOOK_KEYS = ['path', 'events', 'secret_env'];
const INBOUND_KEYS = ['domain', 'env'];
const USES_KEYS = ['erase'];

/** Collects issues so a run reports all of them, not only the first. */
interface Issues {
  list: ManifestIssue[];
}

/** A value read from TOML, with the key path it came from. */
interface Located<T> {
  path: string;
  value: T;
}

function addIssue(opts: { issues: Issues; path: string; message: string }): void {
  opts.issues.list.push({ path: opts.path, message: opts.message });
}

function isRecord(value: unknown): value is TomlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function joinPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a date';
  if (isRecord(value)) return 'a table';
  return `a ${typeof value}`;
}

function checkUnknownKeys(opts: { issues: Issues; table: TomlRecord; allowed: string[]; base: string }): void {
  for (const key of Object.keys(opts.table)) {
    if (opts.allowed.includes(key)) continue;
    addIssue({
      issues: opts.issues,
      path: joinPath(opts.base, key),
      message: `Unknown key. Allowed here: ${opts.allowed.join(', ')}.`,
    });
  }
}

function readString(opts: {
  issues: Issues;
  table: TomlRecord;
  key: string;
  base: string;
  isRequired: boolean;
}): string | null {
  const path = joinPath(opts.base, opts.key);
  const value = opts.table[opts.key];
  if (value === undefined) {
    if (opts.isRequired) addIssue({ issues: opts.issues, path, message: 'Required. Add this key.' });
    return null;
  }
  if (typeof value !== 'string') {
    addIssue({ issues: opts.issues, path, message: `Must be a string, found ${describeType(value)}.` });
    return null;
  }
  if (value.trim() === '') {
    addIssue({ issues: opts.issues, path, message: 'Must not be empty.' });
    return null;
  }
  return value;
}

function readBoolean(opts: { issues: Issues; table: TomlRecord; key: string; base: string }): boolean {
  const value = opts.table[opts.key];
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  addIssue({
    issues: opts.issues,
    path: joinPath(opts.base, opts.key),
    message: `Must be true or false, found ${describeType(value)}.`,
  });
  return false;
}

function looksLikeUrl(value: string): boolean {
  return value.includes('://') || /^(https?:|www\.)/i.test(value);
}

/** Known token prefixes, or a long mixed run of letters and digits with no word breaks. */
function looksLikeSecret(value: string): boolean {
  if (SECRET_PREFIX_PATTERN.test(value)) return true;
  const isLongToken = value.length >= 20 && !/[_\s]/.test(value);
  return isLongToken && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * Checks an env var NAME. The value is never echoed: a field that holds a
 * secret by mistake must not copy that secret into the error output.
 */
function checkEnvName(opts: { issues: Issues; path: string; value: string }): void {
  const { issues, path, value } = opts;
  if (looksLikeUrl(value)) {
    addIssue({
      issues,
      path,
      message: 'Looks like a URL. Names only: put the env var name here (for example PIGEON_BASE_URL), never its value.',
    });
    return;
  }
  if (looksLikeSecret(value)) {
    addIssue({
      issues,
      path,
      message: 'Looks like a secret. Names only: put the env var name here (for example PIGEON_API_KEY), never its value.',
    });
    return;
  }
  if (ENV_NAME_PATTERN.test(value)) return;
  addIssue({
    issues,
    path,
    message: 'Not an env var name. Names only: use upper case letters, digits and underscores, starting with a letter.',
  });
}

function readEnvName(opts: {
  issues: Issues;
  table: TomlRecord;
  key: string;
  base: string;
  isRequired: boolean;
}): Located<string> | null {
  const value = readString(opts);
  if (value === null) return null;
  const path = joinPath(opts.base, opts.key);
  checkEnvName({ issues: opts.issues, path, value });
  return { path, value };
}

function readDomainName(opts: { issues: Issues; table: TomlRecord; key: string; base: string }): string | null {
  const raw = readString({ ...opts, isRequired: true });
  if (raw === null) return null;
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (DOMAIN_PATTERN.test(domain)) return domain;
  addIssue({
    issues: opts.issues,
    path: joinPath(opts.base, opts.key),
    message: 'Not a domain name. Use a bare domain such as example.com.',
  });
  return null;
}

/** Reads an optional `[[section]]` array of tables. Missing means empty. */
function readTableArray(opts: { issues: Issues; root: TomlRecord; key: string }): Array<Located<TomlRecord>> {
  const value = opts.root[opts.key];
  if (value === undefined) return [];
  const isTableArray = Array.isArray(value) && value.every((entry) => isRecord(entry));
  if (!isTableArray) {
    addIssue({
      issues: opts.issues,
      path: opts.key,
      message: `Must be an array of tables. Write each entry as [[${opts.key}]].`,
    });
    return [];
  }
  return value.map((entry: TomlRecord, index) => ({ path: `${opts.key}[${index}]`, value: entry }));
}

function readSubTable(opts: { issues: Issues; root: TomlRecord; key: string; isRequired: boolean }): TomlRecord | null {
  const value = opts.root[opts.key];
  if (value === undefined) {
    if (opts.isRequired) addIssue({ issues: opts.issues, path: opts.key, message: `Required. Add a [${opts.key}] table.` });
    return null;
  }
  if (isRecord(value)) return value;
  addIssue({ issues: opts.issues, path: opts.key, message: `Must be a table. Write it as [${opts.key}].` });
  return null;
}

function checkSchema(opts: { issues: Issues; root: TomlRecord }): void {
  const value = opts.root.schema;
  if (value === undefined) {
    addIssue({ issues: opts.issues, path: 'schema', message: `Required. Add schema = ${MANIFEST_SCHEMA_VERSION}.` });
    return;
  }
  if (value === MANIFEST_SCHEMA_VERSION) return;
  addIssue({
    issues: opts.issues,
    path: 'schema',
    message: `Must be exactly ${MANIFEST_SCHEMA_VERSION}. This CLI reads schema ${MANIFEST_SCHEMA_VERSION} only.`,
  });
}

function readEnvTable(opts: { issues: Issues; root: TomlRecord }): {
  apiKey: Located<string> | null;
  baseUrl: Located<string> | null;
} {
  const table = readSubTable({ issues: opts.issues, root: opts.root, key: 'env', isRequired: true });
  if (table === null) return { apiKey: null, baseUrl: null };
  checkUnknownKeys({ issues: opts.issues, table, allowed: ENV_KEYS, base: 'env' });
  return {
    apiKey: readEnvName({ issues: opts.issues, table, key: 'api_key', base: 'env', isRequired: true }),
    baseUrl: readEnvName({ issues: opts.issues, table, key: 'base_url', base: 'env', isRequired: true }),
  };
}

function readDomains(opts: { issues: Issues; root: TomlRecord }): Array<Located<ManifestDomain>> {
  const { issues } = opts;
  const entries = readTableArray({ issues, root: opts.root, key: 'domains' });
  return entries.flatMap(({ path, value: table }) => {
    checkUnknownKeys({ issues, table, allowed: DOMAIN_KEYS, base: path });
    const name = readDomainName({ issues, table, key: 'name', base: path });
    const receivesMail = readBoolean({ issues, table, key: 'receives_mail', base: path });
    if (name === null) return [];
    return [{ path: `${path}.name`, value: { name, receivesMail } }];
  });
}

function readSenders(opts: {
  issues: Issues;
  root: TomlRecord;
  domainNames: ReadonlySet<string>;
  envNames: Array<Located<string>>;
}): Array<Located<ManifestSender>> {
  const { issues } = opts;
  const entries = readTableArray({ issues, root: opts.root, key: 'senders' });
  return entries.flatMap(({ path, value: table }) => {
    checkUnknownKeys({ issues, table, allowed: SENDER_KEYS, base: path });
    const address = readString({ issues, table, key: 'address', base: path, isRequired: true });
    const purpose = readString({ issues, table, key: 'purpose', base: path, isRequired: true });
    const env = readEnvName({ issues, table, key: 'env', base: path, isRequired: false });
    if (env !== null) opts.envNames.push(env);
    if (address === null) return [];

    const addressPath = `${path}.address`;
    const match = ADDRESS_PATTERN.exec(address.trim());
    const domain = match?.[1]?.toLowerCase() ?? null;
    if (domain === null) {
      addIssue({ issues, path: addressPath, message: 'Not an email address. Use local@domain.' });
      return [];
    }
    if (!opts.domainNames.has(domain)) {
      addIssue({
        issues,
        path: addressPath,
        message: `The domain ${domain} is not declared. Add a [[domains]] entry with name = "${domain}".`,
      });
    }
    if (purpose === null) return [];
    return [{ path: addressPath, value: { address: address.trim(), purpose, env: env?.value ?? null } }];
  });
}

function readAudiences(opts: {
  issues: Issues;
  root: TomlRecord;
  envNames: Array<Located<string>>;
}): Array<Located<ManifestAudience>> {
  const { issues } = opts;
  const entries = readTableArray({ issues, root: opts.root, key: 'audiences' });
  return entries.flatMap(({ path, value: table }) => {
    checkUnknownKeys({ issues, table, allowed: AUDIENCE_KEYS, base: path });
    const name = readString({ issues, table, key: 'name', base: path, isRequired: true });
    const idEnv = readEnvName({ issues, table, key: 'id_env', base: path, isRequired: false });
    const description = readString({ issues, table, key: 'description', base: path, isRequired: false });
    if (idEnv !== null) opts.envNames.push(idEnv);
    if (name === null) return [];
    if (name.length > MAX_AUDIENCE_NAME_LENGTH) {
      addIssue({ issues, path: `${path}.name`, message: `Must be at most ${MAX_AUDIENCE_NAME_LENGTH} characters.` });
      return [];
    }
    return [{ path: `${path}.name`, value: { name, idEnv: idEnv?.value ?? null, description } }];
  });
}

function checkWebhookPath(opts: { issues: Issues; path: string; value: string }): boolean {
  const { value } = opts;
  const problem = describeWebhookPathProblem(value);
  if (problem === null) return true;
  addIssue({ issues: opts.issues, path: opts.path, message: problem });
  return false;
}

function describeWebhookPathProblem(value: string): string | null {
  if (looksLikeUrl(value)) return 'Path only, no scheme or host. Pass the origin with --origin at plan or apply time.';
  if (!value.startsWith('/')) return 'Must start with "/".';
  if (value.startsWith('//')) return 'Must not start with "//". Use a path such as /webhooks/pigeon.';
  if (/[\s?#]/.test(value)) return 'Path only: no spaces, no query string, no fragment.';
  return null;
}

function readEvents(opts: { issues: Issues; table: TomlRecord; base: string }): string[] | null {
  const { issues } = opts;
  const path = joinPath(opts.base, 'events');
  const value = opts.table.events;
  if (value === undefined) {
    addIssue({ issues, path, message: `Required. List event types: ${EVENT_LIST}.` });
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    addIssue({ issues, path, message: `Must be a non-empty array of event types: ${EVENT_LIST}.` });
    return null;
  }

  const seen = new Set<string>();
  let isValid = true;
  value.forEach((event: unknown, index) => {
    const eventPath = `${path}[${index}]`;
    if (typeof event !== 'string') {
      addIssue({ issues, path: eventPath, message: `Must be a string, found ${describeType(event)}.` });
      isValid = false;
      return;
    }
    if (!KNOWN_EVENTS.has(event)) {
      addIssue({ issues, path: eventPath, message: `Unknown event type "${event}". Use ${EVENT_LIST}.` });
      isValid = false;
      return;
    }
    if (seen.has(event)) {
      addIssue({ issues, path: eventPath, message: `"${event}" is listed twice.` });
      isValid = false;
      return;
    }
    seen.add(event);
  });

  if (seen.has(ALL_EVENTS) && value.length > 1) {
    addIssue({ issues, path, message: `Use ${ALL_EVENTS} alone. It already covers every event type.` });
    return null;
  }
  return isValid ? [...seen] : null;
}

function readWebhooks(opts: {
  issues: Issues;
  root: TomlRecord;
  envNames: Array<Located<string>>;
}): Array<Located<ManifestWebhook>> {
  const { issues } = opts;
  const entries = readTableArray({ issues, root: opts.root, key: 'webhooks' });
  return entries.flatMap(({ path, value: table }) => {
    checkUnknownKeys({ issues, table, allowed: WEBHOOK_KEYS, base: path });
    const webhookPath = readString({ issues, table, key: 'path', base: path, isRequired: true });
    const events = readEvents({ issues, table, base: path });
    const secretEnv = readEnvName({ issues, table, key: 'secret_env', base: path, isRequired: true });
    if (secretEnv !== null) opts.envNames.push(secretEnv);

    const isPathValid = webhookPath !== null && checkWebhookPath({ issues, path: `${path}.path`, value: webhookPath });
    if (!isPathValid || webhookPath === null || events === null || secretEnv === null) return [];
    return [{ path: `${path}.path`, value: { path: webhookPath, events, secretEnv: secretEnv.value } }];
  });
}

function readInbound(opts: {
  issues: Issues;
  root: TomlRecord;
  envNames: Array<Located<string>>;
}): Array<Located<ManifestInbound>> {
  const { issues } = opts;
  const entries = readTableArray({ issues, root: opts.root, key: 'inbound' });
  return entries.flatMap(({ path, value: table }) => {
    checkUnknownKeys({ issues, table, allowed: INBOUND_KEYS, base: path });
    const domain = readDomainName({ issues, table, key: 'domain', base: path });
    const env = readEnvName({ issues, table, key: 'env', base: path, isRequired: false });
    if (env !== null) opts.envNames.push(env);
    if (domain === null) return [];
    return [{ path: `${path}.domain`, value: { domain, env: env?.value ?? null } }];
  });
}

function readUses(opts: { issues: Issues; root: TomlRecord }): { erase: boolean } {
  const table = readSubTable({ issues: opts.issues, root: opts.root, key: 'uses', isRequired: false });
  if (table === null) return { erase: false };
  checkUnknownKeys({ issues: opts.issues, table, allowed: USES_KEYS, base: 'uses' });
  return { erase: readBoolean({ issues: opts.issues, table, key: 'erase', base: 'uses' }) };
}

/** Reports every repeat of a key after its first use. */
function checkDuplicates(opts: { issues: Issues; entries: Array<Located<string>>; what: string }): void {
  const firstPathByKey = new Map<string, string>();
  for (const entry of opts.entries) {
    const firstPath = firstPathByKey.get(entry.value);
    if (firstPath === undefined) {
      firstPathByKey.set(entry.value, entry.path);
      continue;
    }
    addIssue({
      issues: opts.issues,
      path: entry.path,
      message: `Duplicate ${opts.what} "${entry.value}". It is already declared at ${firstPath}.`,
    });
  }
}

function keyed<T>(entries: Array<Located<T>>, pick: (value: T) => string): Array<Located<string>> {
  return entries.map((entry) => ({ path: entry.path, value: pick(entry.value) }));
}

function parseToml(text: string): { ok: true; root: TomlRecord } | { ok: false; issue: ManifestIssue } {
  try {
    return { ok: true, root: parse(text) };
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    // The full message quotes the offending line, which may hold a pasted secret.
    const reason = error.message.split('\n')[0] ?? 'Invalid TOML document';
    return {
      ok: false,
      issue: { path: '(toml)', message: `${reason} (line ${error.line}, column ${error.column}).` },
    };
  }
}

export function parseManifest(text: string): ManifestParseResult {
  const parsed = parseToml(text);
  if (!parsed.ok) return { ok: false, issues: [parsed.issue] };

  const { root } = parsed;
  const issues: Issues = { list: [] };
  checkUnknownKeys({ issues, table: root, allowed: TOP_LEVEL_KEYS, base: '' });
  checkSchema({ issues, root });

  const app = readString({ issues, table: root, key: 'app', base: '', isRequired: true });
  const env = readEnvTable({ issues, root });
  const envNames = [env.apiKey, env.baseUrl].filter((entry): entry is Located<string> => entry !== null);

  const domains = readDomains({ issues, root });
  const domainNames = new Set(domains.map((entry) => entry.value.name));
  const senders = readSenders({ issues, root, domainNames, envNames });
  const audiences = readAudiences({ issues, root, envNames });
  const webhooks = readWebhooks({ issues, root, envNames });
  const inbound = readInbound({ issues, root, envNames });
  const uses = readUses({ issues, root });

  checkDuplicates({ issues, entries: keyed(domains, (domain) => domain.name), what: 'domain' });
  checkDuplicates({ issues, entries: keyed(senders, (sender) => sender.address.toLowerCase()), what: 'sender address' });
  checkDuplicates({ issues, entries: keyed(audiences, (audience) => audience.name), what: 'audience name' });
  checkDuplicates({ issues, entries: keyed(webhooks, (webhook) => webhook.path), what: 'webhook path' });
  checkDuplicates({ issues, entries: keyed(inbound, (entry) => entry.domain), what: 'inbound domain' });
  checkDuplicates({ issues, entries: envNames, what: 'env var name' });

  const wantsReceived = webhooks.some((entry) => entry.value.events.includes('email.received'));
  if (wantsReceived && inbound.length === 0) {
    const first = webhooks.find((entry) => entry.value.events.includes('email.received'));
    addIssue({
      issues,
      path: first?.path.replace(/\.path$/, '.events') ?? 'webhooks',
      message: 'email.received needs at least one [[inbound]] entry. Declare the domain the app receives mail on.',
    });
  }

  if (issues.list.length > 0 || app === null || env.apiKey === null || env.baseUrl === null) {
    return { ok: false, issues: issues.list };
  }

  return {
    ok: true,
    manifest: {
      schema: MANIFEST_SCHEMA_VERSION,
      app,
      env: { apiKey: env.apiKey.value, baseUrl: env.baseUrl.value },
      domains: domains.map((entry) => entry.value),
      senders: senders.map((entry) => entry.value),
      audiences: audiences.map((entry) => entry.value),
      webhooks: webhooks.map((entry) => entry.value),
      inbound: inbound.map((entry) => entry.value),
      uses,
    },
  };
}

/** One line per issue, `path: message`. */
export function formatManifestIssues(issues: ManifestIssue[]): string {
  return issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
}
