/**
 * DTOs for the `/v1/audiences` and `/v1/audiences/:id/contacts` endpoints.
 */

export interface CreateAudienceRequest {
  name: string;
  description?: string;
}

export interface UpdateAudienceRequest {
  name?: string;
  description?: string;
}

export interface Audience {
  id: string;
  appId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAudienceResponse {
  audience: Audience;
}

export interface GetAudienceResponse {
  audience: Audience;
}

export interface ListAudiencesResponse {
  audiences: Audience[];
}

export interface DeleteAudienceResponse {
  success: true;
}

// Contacts ------------------------------------------------------------------

export interface ContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown>;
}

export interface UpdateContactRequest {
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, unknown>;
  /**
   * Re-subscribe a contact that unsubscribed. The only accepted value is
   * `'subscribed'`. The server answers 409 `contact_suppressed` for a contact
   * that bounced, complained or is on the suppression list.
   */
  status?: 'subscribed';
}

export type ContactStatus = 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | string;

export interface Contact {
  id: string;
  appId: string;
  audienceId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  attributes: Record<string, unknown> | null;
  status: ContactStatus;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddContactResponse {
  contact: Contact;
}

export interface GetContactResponse {
  contact: Contact;
}

export interface ListContactsRequest {
  limit?: number;
  offset?: number;
}

export interface ListContactsResponse {
  contacts: Contact[];
  limit: number;
  offset: number;
}

export interface BulkAddContactsResponse {
  count: number;
  contacts: Contact[];
}

export interface UnsubscribeContactResponse {
  success: true;
  status: 'unsubscribed';
}
