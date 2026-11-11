/**
 * How the webhook worker sends one POST.
 *
 * - `fetchTransport`: global fetch, which follows redirects. Used only while
 *   PIGEON_WEBHOOK_PRIVATE_TARGETS=allow, which a deployment has to set.
 * - `createPinnedTransport`: node:http / node:https with a lookup that
 *   resolves the host once, refuses any answer the address rule refuses and
 *   connects to the addresses it checked (app/lib/webhook-target.ts). It never follows a
 *   redirect: a 3xx is the answer, so a receiver cannot bounce the worker to a
 *   private address. TLS still verifies the certificate against the host name.
 *   Used under PIGEON_WEBHOOK_PRIVATE_TARGETS=deny, the default.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  createPinnedLookup,
  WebhookTargetRefusedError,
  type AddressRule,
  type ResolveHost,
} from '#app/lib/webhook-target';

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface WebhookResponse {
  status: number;
  /** The first `maxChars` characters of the body, or '' when it cannot be read. */
  readSnippet(maxChars: number): Promise<string>;
  /** Releases the connection when the body is not read. */
  discard(): void;
}

export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

export const fetchTransport: WebhookTransport = async (request) => {
  const res = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });
  return {
    status: res.status,
    readSnippet: async (maxChars) => {
      try {
        return (await res.text()).slice(0, maxChars);
      } catch {
        return '';
      }
    },
    discard: () => {
      void res.body?.cancel().catch(() => undefined);
    },
  };
};

function readLimited(opts: { response: http.IncomingMessage; maxChars: number }): Promise<string> {
  const { response, maxChars } = opts;
  return new Promise((resolve) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      text += chunk;
      if (text.length >= maxChars) response.destroy();
    });
    response.on('end', () => resolve(text.slice(0, maxChars)));
    response.on('close', () => resolve(text.slice(0, maxChars)));
    response.on('error', () => resolve(text.slice(0, maxChars)));
  });
}

export function createPinnedTransport(opts: {
  resolveHost: ResolveHost;
  isAllowedAddress: AddressRule;
}): WebhookTransport {
  const lookup = createPinnedLookup(opts);

  return (request) =>
    new Promise<WebhookResponse>((resolve, reject) => {
      const url = new URL(request.url);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      // A socket connect skips lookup for an IP literal, so check it here.
      if (isIP(hostname) !== 0 && !opts.isAllowedAddress({ hostname, address: hostname })) {
        reject(new WebhookTargetRefusedError(`${hostname} is a non-public address`));
        return;
      }
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(
        url,
        {
          method: 'POST',
          headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body)) },
          lookup,
          agent: false,
          signal: request.signal,
        },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            readSnippet: (maxChars) => readLimited({ response, maxChars }),
            discard: () => response.destroy(),
          }),
      );
      req.on('error', reject);
      req.end(request.body);
    });
}
