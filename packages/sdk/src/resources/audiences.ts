/**
 * Audiences resource — maps to `/v1/audiences` on the service.
 *
 * Contact management lives on a separate `Contacts` resource so that the
 * call signatures (`audienceId` first) read cleanly.
 */

import type { RequestFn } from '../client';
import type {
  CreateAudienceRequest,
  UpdateAudienceRequest,
  Audience,
  CreateAudienceResponse,
  GetAudienceResponse,
  ListAudiencesResponse,
  DeleteAudienceResponse,
} from '../types/audiences';

export interface AudiencesReadOptions {
  signal?: AbortSignal;
}

export interface AudiencesWriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class Audiences {
  constructor(private readonly request: RequestFn) {}

  async create(
    body: CreateAudienceRequest,
    opts: AudiencesWriteOptions = {},
  ): Promise<Audience> {
    const res = await this.request<CreateAudienceResponse>({
      method: 'POST',
      path: '/v1/audiences',
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.audience;
  }

  async list(opts: AudiencesReadOptions = {}): Promise<Audience[]> {
    const res = await this.request<ListAudiencesResponse>({
      method: 'GET',
      path: '/v1/audiences',
      signal: opts.signal,
    });
    return res.audiences;
  }

  async get(id: string, opts: AudiencesReadOptions = {}): Promise<Audience> {
    const res = await this.request<GetAudienceResponse>({
      method: 'GET',
      path: `/v1/audiences/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
    return res.audience;
  }

  async update(
    id: string,
    body: UpdateAudienceRequest,
    opts: AudiencesWriteOptions = {},
  ): Promise<Audience> {
    const res = await this.request<GetAudienceResponse>({
      method: 'PATCH',
      path: `/v1/audiences/${encodeURIComponent(id)}`,
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.audience;
  }

  async delete(
    id: string,
    opts: AudiencesReadOptions = {},
  ): Promise<DeleteAudienceResponse> {
    return this.request<DeleteAudienceResponse>({
      method: 'DELETE',
      path: `/v1/audiences/${encodeURIComponent(id)}`,
      signal: opts.signal,
    });
  }
}
