/**
 * Contacts resource — maps to `/v1/audiences/:audienceId/contacts` on the service.
 *
 * `remove` is a soft-delete: the server marks the contact `unsubscribed`
 * rather than actually deleting the row (matches the HTTP handler in
 * `api.v1.audiences.$audienceId.contacts.$id.tsx`).
 */

import type { RequestFn } from '../client';
import type {
  ContactInput,
  UpdateContactRequest,
  Contact,
  AddContactResponse,
  GetContactResponse,
  ListContactsRequest,
  ListContactsResponse,
  BulkAddContactsResponse,
  UnsubscribeContactResponse,
} from '../types/audiences';

export interface ContactsReadOptions {
  signal?: AbortSignal;
}

export interface ContactsWriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class Contacts {
  constructor(private readonly request: RequestFn) {}

  async add(
    audienceId: string,
    body: ContactInput,
    opts: ContactsWriteOptions = {},
  ): Promise<Contact> {
    const res = await this.request<AddContactResponse>({
      method: 'POST',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts`,
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.contact;
  }

  /**
   * Bulk upsert up to 100 contacts into a single audience. The server
   * cap is 100 (not 1000 as originally sketched in the spec); chunk on
   * the caller side if you have more.
   */
  async bulkAdd(
    audienceId: string,
    contacts: ContactInput[],
    opts: ContactsWriteOptions = {},
  ): Promise<BulkAddContactsResponse> {
    return this.request<BulkAddContactsResponse>({
      method: 'POST',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts/bulk`,
      body: { contacts },
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
  }

  async list(
    audienceId: string,
    params: ListContactsRequest = {},
    opts: ContactsReadOptions = {},
  ): Promise<ListContactsResponse> {
    return this.request<ListContactsResponse>({
      method: 'GET',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts`,
      query: { limit: params.limit, offset: params.offset },
      signal: opts.signal,
    });
  }

  async get(
    audienceId: string,
    contactId: string,
    opts: ContactsReadOptions = {},
  ): Promise<Contact> {
    const res = await this.request<GetContactResponse>({
      method: 'GET',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts/${encodeURIComponent(contactId)}`,
      signal: opts.signal,
    });
    return res.contact;
  }

  async update(
    audienceId: string,
    contactId: string,
    body: UpdateContactRequest,
    opts: ContactsWriteOptions = {},
  ): Promise<Contact> {
    const res = await this.request<GetContactResponse>({
      method: 'PATCH',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts/${encodeURIComponent(contactId)}`,
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.contact;
  }

  /** Unsubscribe a contact (server performs a soft-delete). */
  async remove(
    audienceId: string,
    contactId: string,
    opts: ContactsReadOptions = {},
  ): Promise<UnsubscribeContactResponse> {
    return this.request<UnsubscribeContactResponse>({
      method: 'DELETE',
      path: `/v1/audiences/${encodeURIComponent(audienceId)}/contacts/${encodeURIComponent(contactId)}`,
      signal: opts.signal,
    });
  }
}
