/**
 * @sprqvntrs/pigeon — SDK for the Pigeon email service
 *
 * Quickstart:
 *
 *   import { PigeonClient } from '@sprqvntrs/pigeon';
 *
 *   const pigeon = new PigeonClient({
 *     apiKey: env.PIGEON_API_KEY,
 *     baseUrl: env.PIGEON_BASE_URL, // for example https://pigeon.example.com
 *   });
 *
 *   await pigeon.emails.send({
 *     from: 'hello@example.com',
 *     to: ['user@example.com'],
 *     subject: 'Hi',
 *     html: '<p>hello</p>',
 *   }, { idempotencyKey: crypto.randomUUID() });
 *
 * Error handling:
 *
 *   import { PigeonError } from '@sprqvntrs/pigeon';
 *
 *   try { … } catch (e) {
 *     if (e instanceof PigeonError) {
 *       switch (e.code) {
 *         case 'domain_not_verified': …
 *         case 'rate_limited':        …
 *         default:                    throw e;
 *       }
 *     }
 *     throw e;
 *   }
 */

export { PigeonClient } from './client';
export type { PigeonClientOptions } from './client';

export {
  PigeonError,
  parseServiceError,
} from './errors';
export type { ErrorCode, PigeonErrorOptions } from './errors';

export { Emails } from './resources/emails';
export { Domains } from './resources/domains';
export { Audiences } from './resources/audiences';
export { Contacts } from './resources/contacts';

// Types
export type {
  SendEmailRequest,
  SendEmailResponse,
  Email,
  ListEmailsRequest,
  ListEmailsResponse,
  GetEmailResponse,
  WriteOptions,
} from './types/emails';

export type {
  CreateDomainRequest,
  CreateDomainResponse,
  GetDomainResponse,
  ListDomainsResponse,
  VerifyDomainResponse,
  DeleteDomainResponse,
  Domain,
  DnsRecord,
  DnsRecordType,
  VerificationStatus,
} from './types/domains';

export type {
  CreateAudienceRequest,
  UpdateAudienceRequest,
  Audience,
  CreateAudienceResponse,
  GetAudienceResponse,
  ListAudiencesResponse,
  DeleteAudienceResponse,
  ContactInput,
  UpdateContactRequest,
  Contact,
  ContactStatus,
  AddContactResponse,
  GetContactResponse,
  ListContactsRequest,
  ListContactsResponse,
  BulkAddContactsResponse,
  UnsubscribeContactResponse,
} from './types/audiences';

export { version } from './version';
