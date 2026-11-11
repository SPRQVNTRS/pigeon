/**
 * Domains resource — maps to `/v1/domains` on the service.
 */

import type { RequestFn } from '../client';
import type {
  CreateDomainRequest,
  CreateDomainResponse,
  GetDomainResponse,
  ListDomainsResponse,
  VerifyDomainResponse,
  DeleteDomainResponse,
} from '../types/domains';

export interface DomainsReadOptions {
  signal?: AbortSignal;
}

export interface DomainsWriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class Domains {
  constructor(private readonly request: RequestFn) {}

  async create(
    body: CreateDomainRequest,
    opts: DomainsWriteOptions = {},
  ): Promise<CreateDomainResponse> {
    return this.request<CreateDomainResponse>({
      method: 'POST',
      path: '/v1/domains',
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  async list(opts: DomainsReadOptions = {}): Promise<ListDomainsResponse> {
    return this.request<ListDomainsResponse>({
      method: 'GET',
      path: '/v1/domains',
      signal: opts.signal,
    });
  }

  async get(id: string, opts: DomainsReadOptions = {}): Promise<GetDomainResponse> {
    return this.request<GetDomainResponse>({
      method: 'GET',
      path: `/v1/domains/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }

  async verify(
    id: string,
    opts: DomainsWriteOptions = {},
  ): Promise<VerifyDomainResponse> {
    return this.request<VerifyDomainResponse>({
      method: 'POST',
      path: `/v1/domains/${encodeURIComponent(id)}/verify`,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  async delete(
    id: string,
    opts: DomainsReadOptions = {},
  ): Promise<DeleteDomainResponse> {
    return this.request<DeleteDomainResponse>({
      method: 'DELETE',
      path: `/v1/domains/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }
}
