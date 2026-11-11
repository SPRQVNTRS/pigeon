import type {
  PigeonApp,
  PigeonApiKey,
  PigeonApiKeyListItem,
  PigeonAudience,
  PigeonDomainRegisterResponse,
  PigeonDomainGetResponse,
  PigeonDomainListResponse,
  PigeonDomainVerifyResponse,
  PigeonInboundDomain,
  PigeonInboundEmailSummary,
  PigeonInboundReplay,
  PigeonWebhook,
  PigeonWebhookWithSecret,
} from './types.js';
import { getAdminUrl } from './config.js';
import { PigeonHttpError } from './http-errors.js';
import { STATE_VERSION_HEADER, StateVersionConflictError, ifMatchValue, parseStateVersionHeader } from './state-version.js';

export { PigeonHttpError } from './http-errors.js';

const REQUEST_TIMEOUT_MS = 30_000;
const HEALTHZ_TIMEOUT_MS = 10_000;
const MAX_ERROR_FIELD_LENGTH = 200;

/** The server answered 409 webhook_exists. Carries the id of the existing webhook. */
export class WebhookExistsError extends PigeonHttpError {
  readonly webhookId: string;

  constructor(opts: { status: number; message: string; webhookId: string }) {
    super({ status: opts.status, code: 'webhook_exists', message: opts.message });
    this.name = 'WebhookExistsError';
    this.webhookId = opts.webhookId;
  }
}

/** A 2xx answer that is not valid JSON or has the wrong shape. The body is never echoed. */
export class PigeonUnreadableResponseError extends Error {
  constructor(opts: { status: number; httpMethod: string; path: string }) {
    super(
      `Pigeon answered ${opts.status} on ${opts.httpMethod} ${opts.path}, but the answer could not be read. ` +
        'The body is not shown because it may hold a secret.',
    );
    this.name = 'PigeonUnreadableResponseError';
  }
}

/** The version handshake could not read an answer from the server. A refusal, not a skip. */
export class PigeonUnreachableError extends Error {
  constructor(opts: { baseUrl: string; reason: string }) {
    super(`Cannot reach pigeon at ${opts.baseUrl}: ${opts.reason}`);
    this.name = 'PigeonUnreachableError';
  }
}

function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `no answer within ${HEALTHZ_TIMEOUT_MS / 1000}s`;
  }
  if (!(error instanceof Error)) return 'the request failed';
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The error code of a pigeon error body: `error.code` of `{ error: { code } }`,
 * or the string of `{ error: 'code' }` (POST /v1/admin/apps answers 409 that
 * way). Null when the body is neither shape.
 */
function readErrorCode(text: string): string | null {
  const parsed = parseJsonOrNull(text);
  if (!isRecord(parsed)) return null;
  if (typeof parsed.error === 'string') return parsed.error.slice(0, MAX_ERROR_FIELD_LENGTH);
  const error = isRecord(parsed.error) ? parsed.error : null;
  return typeof error?.code === 'string' ? error.code.slice(0, MAX_ERROR_FIELD_LENGTH) : null;
}

/**
 * True when a per-app admin route does not exist on the server. The router
 * answers an unknown path with a 404 HTML page, so that 404 has no `error.code`.
 * A route that exists answers an unknown app with 404 and code `app_not_found`.
 */
export function isMissingRouteError(error: unknown): boolean {
  if (!(error instanceof PigeonHttpError)) return false;
  return error.status === 404 && error.code !== 'app_not_found';
}

function isWebhookWithSecret(value: unknown): value is PigeonWebhookWithSecret {
  if (!isRecord(value)) return false;
  if (typeof value.signingSecret !== 'string' || value.signingSecret === '') return false;
  return isRecord(value.webhook) && typeof value.webhook.id === 'string';
}

function describeSensitiveError(opts: {
  status: number;
  httpMethod: string;
  path: string;
  text: string;
}): PigeonHttpError {
  const parsed = parseJsonOrNull(opts.text);
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  const code = typeof error?.code === 'string' ? error.code.slice(0, MAX_ERROR_FIELD_LENGTH) : null;
  const hasSecretField = opts.text.includes('signingSecret');
  const serverMessage =
    !hasSecretField && typeof error?.message === 'string'
      ? error.message.slice(0, MAX_ERROR_FIELD_LENGTH)
      : null;

  const parts = [code, serverMessage].filter((part): part is string => part !== null);
  const detail = parts.length > 0 ? `: ${parts.join(': ')}` : '';
  const message = `Pigeon API error ${opts.status} on ${opts.httpMethod} ${opts.path}${detail}`;

  if (code === 'webhook_exists' && isRecord(error) && typeof error.webhookId === 'string') {
    return new WebhookExistsError({ status: opts.status, message, webhookId: error.webhookId });
  }
  return new PigeonHttpError({ status: opts.status, code, message });
}

/**
 * A 412 whose body is the server's state version mismatch. Anything else that
 * answers 412 is left to the generic error path.
 */
function readStateVersionConflict(text: string): StateVersionConflictError | null {
  const parsed = parseJsonOrNull(text);
  if (!isRecord(parsed) || parsed.error !== 'state_version_mismatch') return null;
  const { expected, current } = parsed;
  if (typeof expected !== 'number' || typeof current !== 'number') return null;
  return new StateVersionConflictError({ expected, current });
}

/** A read or write of one app's configuration, with the app's state version the server reported. */
export type WithStateVersion<T> = T & {
  /** Null when the server sent no Pigeon-State-Version header (a server too old for guarded writes). */
  stateVersion: number | null;
};

function appPath(appId: string): string {
  return `/v1/admin/apps/${encodeURIComponent(appId)}`;
}

export class PigeonClient {
  private baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = (opts.baseUrl ?? getAdminUrl()).replace(/\/$/, '');
  }

  private async request<T>(opts: {
    httpMethod: 'GET' | 'POST' | 'PATCH';
    path: string;
    token: string;
    body?: unknown;
    /** The success body holds a secret. Errors then never echo the response body. */
    isSensitive?: boolean;
    /** Sent as If-Match: the server answers 412 (StateVersionConflictError) when the app moved on. */
    expectedVersion?: number;
  }): Promise<{ status: number; data: T; stateVersion: number | null }> {
    const url = `${this.baseUrl}${opts.path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: opts.httpMethod,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
          ...(opts.expectedVersion === undefined ? {} : { 'If-Match': ifMatchValue(opts.expectedVersion) }),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();

      if (response.status === 412) {
        const conflict = readStateVersionConflict(text);
        if (conflict !== null) throw conflict;
      }

      if (!response.ok && opts.isSensitive) {
        throw describeSensitiveError({
          status: response.status,
          httpMethod: opts.httpMethod,
          path: opts.path,
          text,
        });
      }

      if (!response.ok) {
        throw new PigeonHttpError({
          status: response.status,
          code: readErrorCode(text),
          message: `Pigeon API error ${response.status} on ${opts.httpMethod} ${opts.path}: ${text.slice(0, 500)}`,
        });
      }

      const stateVersion = parseStateVersionHeader(response.headers.get(STATE_VERSION_HEADER));

      if (opts.isSensitive) {
        // JSON.parse errors quote part of the input, so parse without letting them escape.
        const parsed = parseJsonOrNull(text);
        if (parsed === null) {
          throw new PigeonUnreadableResponseError({
            status: response.status,
            httpMethod: opts.httpMethod,
            path: opts.path,
          });
        }
        return { status: response.status, data: parsed as T, stateVersion };
      }

      const data = (text ? JSON.parse(text) : {}) as T;
      return { status: response.status, data, stateVersion };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Pigeon request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * GET /healthz (no auth) and read `apiVersion` from the JSON body.
   * Returns null when the field is absent (a server that predates the handshake).
   * Returns NaN when the field is present but is not a number, so the check refuses it.
   * A non-2xx answer still counts when its body is JSON: /healthz answers 503 with a body.
   * Throws PigeonUnreachableError on a network failure, a timeout or a body that is not JSON.
   */
  async fetchApiVersion(): Promise<number | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      const parsed = parseJsonOrNull(await response.text());
      if (!isRecord(parsed)) {
        throw new PigeonUnreachableError({
          baseUrl: this.baseUrl,
          reason: `HTTP ${response.status} with a body that is not a JSON object`,
        });
      }
      const value = parsed.apiVersion;
      if (value === undefined || value === null) return null;
      return typeof value === 'number' ? value : Number.NaN;
    } catch (error) {
      if (error instanceof PigeonUnreachableError) throw error;
      throw new PigeonUnreachableError({ baseUrl: this.baseUrl, reason: describeFetchFailure(error) });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async listApps(opts: { adminSecret: string }): Promise<{ status: number; apps: PigeonApp[] }> {
    const { status, data } = await this.request<{ apps: PigeonApp[] }>({
      httpMethod: 'GET',
      path: '/v1/admin/apps',
      token: opts.adminSecret,
    });
    return { status, apps: data.apps };
  }

  /** The new app's state version (0) comes back too: a manifest apply chains its writes from it. */
  async createApp(opts: { adminSecret: string; name: string }): Promise<WithStateVersion<{ app: PigeonApp }>> {
    const { data, stateVersion } = await this.request<{ app: PigeonApp }>({
      httpMethod: 'POST',
      path: '/v1/admin/apps',
      token: opts.adminSecret,
      body: { name: opts.name },
    });
    return { ...data, stateVersion };
  }

  /**
   * The state version of one app, from GET /v1/admin/apps/:id. Null when the
   * server sent no header. A guarded command reads it before its write.
   */
  async getAppStateVersion(opts: { adminSecret: string; appId: string }): Promise<number | null> {
    const { stateVersion } = await this.request<{ app: PigeonApp }>({
      httpMethod: 'GET',
      path: appPath(opts.appId),
      token: opts.adminSecret,
    });
    return stateVersion;
  }

  async createApiKey(opts: {
    adminSecret: string;
    appId: string;
    name: string;
  }): Promise<{ apiKey: PigeonApiKey; plaintext: string }> {
    const { data } = await this.request<{ apiKey: PigeonApiKey; plaintext: string }>({
      httpMethod: 'POST',
      path: '/v1/admin/api-keys',
      token: opts.adminSecret,
      body: { appId: opts.appId, name: opts.name },
    });
    return data;
  }

  /** Lists the keys of one app. Only id, app, name, prefix and revokedAt are read. */
  async listApiKeys(opts: {
    adminSecret: string;
    appId: string;
  }): Promise<{ apiKeys: PigeonApiKeyListItem[] }> {
    const { data } = await this.request<{ apiKeys: PigeonApiKeyListItem[] }>({
      httpMethod: 'GET',
      path: `/v1/admin/api-keys?appId=${encodeURIComponent(opts.appId)}`,
      token: opts.adminSecret,
    });
    return {
      apiKeys: data.apiKeys.map((key) => ({
        id: key.id,
        appId: key.appId,
        name: key.name,
        prefix: key.prefix,
        revokedAt: key.revokedAt ?? null,
      })),
    };
  }

  /**
   * Admin read of one app's sending domains: the entries of GET /v1/domains,
   * read with the admin secret. An older server answers 404 (see isMissingRouteError).
   */
  async listAppDomains(opts: { adminSecret: string; appId: string }): Promise<WithStateVersion<PigeonDomainListResponse>> {
    const { data, stateVersion } = await this.request<PigeonDomainListResponse>({
      httpMethod: 'GET',
      path: `${appPath(opts.appId)}/domains`,
      token: opts.adminSecret,
    });
    return { ...data, stateVersion };
  }

  /** Admin read of one app's audiences: the entries of GET /v1/audiences. */
  async listAppAudiences(opts: {
    adminSecret: string;
    appId: string;
  }): Promise<WithStateVersion<{ audiences: PigeonAudience[] }>> {
    const { data, stateVersion } = await this.request<{ audiences: PigeonAudience[] }>({
      httpMethod: 'GET',
      path: `${appPath(opts.appId)}/audiences`,
      token: opts.adminSecret,
    });
    return { ...data, stateVersion };
  }

  async listAudiences(opts: { tenantKey: string }): Promise<WithStateVersion<{ audiences: PigeonAudience[] }>> {
    const { data, stateVersion } = await this.request<{ audiences: PigeonAudience[] }>({
      httpMethod: 'GET',
      path: '/v1/audiences',
      token: opts.tenantKey,
    });
    return { ...data, stateVersion };
  }

  /** With `expectedVersion` the write is guarded: 412 throws StateVersionConflictError. */
  async createAudience(opts: {
    tenantKey: string;
    name: string;
    description: string | null;
    expectedVersion?: number;
  }): Promise<WithStateVersion<{ audience: PigeonAudience }>> {
    const body = opts.description === null ? { name: opts.name } : { name: opts.name, description: opts.description };
    const { data, stateVersion } = await this.request<{ audience: PigeonAudience }>({
      httpMethod: 'POST',
      path: '/v1/audiences',
      token: opts.tenantKey,
      body,
      expectedVersion: opts.expectedVersion,
    });
    return { ...data, stateVersion };
  }

  /** With `expectedVersion` the write is guarded: 412 throws StateVersionConflictError. */
  async registerDomain(opts: {
    tenantKey: string;
    domain: string;
    expectedVersion?: number;
  }): Promise<WithStateVersion<PigeonDomainRegisterResponse>> {
    const { data, stateVersion } = await this.request<PigeonDomainRegisterResponse>({
      httpMethod: 'POST',
      path: '/v1/domains',
      token: opts.tenantKey,
      body: { name: opts.domain },
      expectedVersion: opts.expectedVersion,
    });
    return { ...data, stateVersion };
  }

  async listDomains(opts: { tenantKey: string }): Promise<WithStateVersion<PigeonDomainListResponse>> {
    const { data, stateVersion } = await this.request<PigeonDomainListResponse>({
      httpMethod: 'GET',
      path: '/v1/domains',
      token: opts.tenantKey,
    });
    return { ...data, stateVersion };
  }

  async getDomain(opts: { tenantKey: string; id: string }): Promise<PigeonDomainGetResponse> {
    const { data } = await this.request<PigeonDomainGetResponse>({
      httpMethod: 'GET',
      path: `/v1/domains/${opts.id}`,
      token: opts.tenantKey,
    });
    return data;
  }

  async verifyDomain(opts: {
    tenantKey: string;
    id: string;
  }): Promise<PigeonDomainVerifyResponse> {
    const { data } = await this.request<PigeonDomainVerifyResponse>({
      httpMethod: 'POST',
      path: `/v1/domains/${opts.id}/verify`,
      token: opts.tenantKey,
    });
    return data;
  }

  async listWebhooks(opts: {
    adminSecret: string;
    appId: string;
  }): Promise<WithStateVersion<{ webhooks: PigeonWebhook[] }>> {
    const { data, stateVersion } = await this.request<{ webhooks: PigeonWebhook[] }>({
      httpMethod: 'GET',
      path: `${appPath(opts.appId)}/webhooks`,
      token: opts.adminSecret,
    });
    return { ...data, stateVersion };
  }

  /**
   * Throws WebhookExistsError on 409. The signing secret is returned once.
   * With `expectedVersion` the write is guarded: 412 throws StateVersionConflictError.
   */
  async createWebhook(opts: {
    adminSecret: string;
    appId: string;
    url: string;
    eventTypes: string[];
    expectedVersion?: number;
  }): Promise<WithStateVersion<PigeonWebhookWithSecret>> {
    const path = `${appPath(opts.appId)}/webhooks`;
    const { status, data, stateVersion } = await this.request<unknown>({
      httpMethod: 'POST',
      path,
      token: opts.adminSecret,
      body: { url: opts.url, eventTypes: opts.eventTypes },
      isSensitive: true,
      expectedVersion: opts.expectedVersion,
    });
    if (isWebhookWithSecret(data)) return { webhook: data.webhook, signingSecret: data.signingSecret, stateVersion };
    throw new PigeonUnreadableResponseError({ status, httpMethod: 'POST', path });
  }

  /** With `expectedVersion` the rotate is guarded: on 412 the secret did not change. */
  async rotateWebhookSecret(opts: {
    adminSecret: string;
    appId: string;
    webhookId: string;
    expectedVersion?: number;
  }): Promise<WithStateVersion<PigeonWebhookWithSecret>> {
    const path = `${appPath(opts.appId)}/webhooks/${encodeURIComponent(opts.webhookId)}/rotate`;
    const { status, data, stateVersion } = await this.request<unknown>({
      httpMethod: 'POST',
      path,
      token: opts.adminSecret,
      isSensitive: true,
      expectedVersion: opts.expectedVersion,
    });
    if (isWebhookWithSecret(data)) return { webhook: data.webhook, signingSecret: data.signingSecret, stateVersion };
    throw new PigeonUnreadableResponseError({ status, httpMethod: 'POST', path });
  }

  /**
   * Replaces the event types of a webhook. The answer never holds the signing secret.
   * With `expectedVersion` the write is guarded: 412 throws StateVersionConflictError.
   */
  async updateWebhookEvents(opts: {
    adminSecret: string;
    appId: string;
    webhookId: string;
    eventTypes: string[];
    expectedVersion?: number;
  }): Promise<WithStateVersion<{ webhook: PigeonWebhook }>> {
    const { data, stateVersion } = await this.request<{ webhook: PigeonWebhook }>({
      httpMethod: 'PATCH',
      path: `${appPath(opts.appId)}/webhooks/${encodeURIComponent(opts.webhookId)}`,
      token: opts.adminSecret,
      body: { eventTypes: opts.eventTypes },
      expectedVersion: opts.expectedVersion,
    });
    return { ...data, stateVersion };
  }

  async listInboundDomains(opts: {
    adminSecret: string;
    appId: string;
  }): Promise<WithStateVersion<{ inboundDomains: PigeonInboundDomain[] }>> {
    const { data, stateVersion } = await this.request<{ inboundDomains: PigeonInboundDomain[] }>({
      httpMethod: 'GET',
      path: `${appPath(opts.appId)}/inbound-domains`,
      token: opts.adminSecret,
    });
    return { ...data, stateVersion };
  }

  /**
   * The server answers 409 inbound_domain_exists when any app already owns the domain.
   * With `expectedVersion` the write is guarded: 412 throws StateVersionConflictError.
   */
  async addInboundDomain(opts: {
    adminSecret: string;
    appId: string;
    name: string;
    expectedVersion?: number;
  }): Promise<WithStateVersion<{ inboundDomain: PigeonInboundDomain }>> {
    const { data, stateVersion } = await this.request<{ inboundDomain: PigeonInboundDomain }>({
      httpMethod: 'POST',
      path: `${appPath(opts.appId)}/inbound-domains`,
      token: opts.adminSecret,
      body: { name: opts.name },
      expectedVersion: opts.expectedVersion,
    });
    return { ...data, stateVersion };
  }

  async listInboundEmails(opts: {
    adminSecret: string;
    appId: string;
    limit?: number;
  }): Promise<{ inboundEmails: PigeonInboundEmailSummary[] }> {
    const query = opts.limit === undefined ? '' : `?limit=${opts.limit}`;
    const { data } = await this.request<{ inboundEmails: PigeonInboundEmailSummary[] }>({
      httpMethod: 'GET',
      path: `${appPath(opts.appId)}/inbound-emails${query}`,
      token: opts.adminSecret,
    });
    return data;
  }

  /** Queues the mail again. 404 when the row is gone, 410 when the raw mail is gone. */
  async replayInboundEmail(opts: {
    adminSecret: string;
    appId: string;
    inboundEmailId: string;
  }): Promise<PigeonInboundReplay> {
    const { data } = await this.request<PigeonInboundReplay>({
      httpMethod: 'POST',
      path: `${appPath(opts.appId)}/inbound-emails/${encodeURIComponent(opts.inboundEmailId)}/replay`,
      token: opts.adminSecret,
    });
    return data;
  }
}
