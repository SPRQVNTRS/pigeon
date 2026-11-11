/**
 * Emails resource — maps to `/v1/emails` on the service.
 *
 * Methods:
 *   send(request, opts?)
 *   get(id, opts?)
 *   list(params?, opts?)
 *
 * `send` is the only write method; pass `opts.idempotencyKey` to make it
 * safe for the SDK to retry on 5xx. Without a key, the SDK will still
 * retry 429 (rate-limited) but NOT 5xx — see fetcher.ts for why.
 */

import type { RequestFn } from '../client';
import type {
  SendEmailRequest,
  SendEmailResponse,
  Email,
  ListEmailsRequest,
  ListEmailsResponse,
  GetEmailResponse,
  WriteOptions,
} from '../types/emails';

export interface ReadOptions {
  signal?: AbortSignal;
}

export class Emails {
  constructor(private readonly request: RequestFn) {}

  async send(
    body: SendEmailRequest,
    opts: WriteOptions = {},
  ): Promise<SendEmailResponse> {
    return this.request<SendEmailResponse>({
      method: 'POST',
      path: '/v1/emails',
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  async get(id: string, opts: ReadOptions = {}): Promise<Email> {
    const res = await this.request<GetEmailResponse>({
      method: 'GET',
      path: `/v1/emails/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
    return res.email;
  }

  async list(
    params: ListEmailsRequest = {},
    opts: ReadOptions = {},
  ): Promise<ListEmailsResponse> {
    return this.request<ListEmailsResponse>({
      method: 'GET',
      path: '/v1/emails',
      query: { limit: params.limit, offset: params.offset },
      signal: opts.signal,
    });
  }
}
