/**
 * PigeonClient — entry point for the @sprqvntrs/pigeon SDK.
 *
 * Holds auth + transport config and exposes the four resource namespaces:
 *
 *   const client = new PigeonClient({ apiKey, baseUrl });
 *   client.emails.send(...)
 *   client.domains.create(...)
 *   client.audiences.create(...)
 *   client.contacts.add(audienceId, contact)
 */

import { sendRequest, type FetcherOptions } from './fetcher';
import { Emails } from './resources/emails';
import { Domains } from './resources/domains';
import { Audiences } from './resources/audiences';
import { Contacts } from './resources/contacts';
import { version as SDK_VERSION } from './version';

export interface PigeonClientOptions {
  /** API key of the form `ske_...`. Required. */
  apiKey: string;
  /**
   * Base URL of your Pigeon service, for example `https://pigeon.example.com`.
   * Required. Must be an absolute http or https URL. Trailing slashes are removed.
   */
  baseUrl: string;
  /** Per-request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Max retries for retryable failures (429, 5xx on idempotent ops). Default 3. */
  maxRetries?: number;
  /** Base retry delay (exponential + full jitter). Default 200 ms. */
  retryDelayMs?: number;
  /** Injected fetch implementation (tests or proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 200;

export interface RequestArgs {
  method: FetcherOptions['method'];
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Internal request-maker passed to resource classes. */
export type RequestFn = <T>(args: RequestArgs) => Promise<T>;

export class PigeonClient {
  readonly emails: Emails;
  readonly domains: Domains;
  readonly audiences: Audiences;
  readonly contacts: Contacts;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly userAgent: string;

  constructor(options: PigeonClientOptions) {
    if (!options.apiKey) {
      throw new Error('PigeonClient: `apiKey` is required');
    }

    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetch;
    this.userAgent = buildUserAgent();

    const request: RequestFn = (args) => this.request(args);

    this.emails = new Emails(request);
    this.domains = new Domains(request);
    this.audiences = new Audiences(request);
    this.contacts = new Contacts(request);
  }

  private async request<T>(args: RequestArgs): Promise<T> {
    const url = buildUrl(this.baseUrl, args.path, args.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };

    if (args.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (args.idempotencyKey) {
      headers['Idempotency-Key'] = args.idempotencyKey;
    }

    const { data } = await sendRequest<T>({
      url,
      method: args.method,
      headers,
      body: args.body,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs,
      idempotent: Boolean(args.idempotencyKey),
      signal: args.signal,
      fetchImpl: this.fetchImpl,
    });

    return data;
  }
}

/**
 * Validate the base URL and strip trailing slashes. Throws on a missing,
 * empty or non-http(s) value, because JS callers get no compiler check.
 */
function normalizeBaseUrl(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(
      'PigeonClient: `baseUrl` is required, for example https://pigeon.example.com',
    );
  }

  const trimmed = url.trim();
  const protocol = parseProtocol(trimmed);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(
      `PigeonClient: \`baseUrl\` must be an absolute http or https URL, got "${trimmed}"`,
    );
  }

  return trimmed.replace(/\/+$/, '');
}

function parseProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  const joined = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
  if (!query) return joined;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${joined}?${qs}` : joined;
}

function buildUserAgent(): string {
  const nodeVersion =
    typeof process !== 'undefined' && process.versions?.node
      ? `node/${process.versions.node}`
      : 'unknown';
  return `@sprqvntrs/pigeon/${SDK_VERSION} (${nodeVersion})`;
}
