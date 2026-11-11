/**
 * DTOs for the `/v1/emails` endpoints.
 *
 * These mirror `apps/service/app/routes/api.v1.emails*.tsx`. They are an
 * intentional duplication of the service's Zod schemas — the SDK is
 * versioned independently from the service, and the contract-test suite
 * surfaces drift.
 */

export interface SendEmailRequest {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  /**
   * Set `false` to keep no html, text or headers in Pigeon once the send is
   * over (reset links, sign-in codes). Recipients, subject and status stay.
   * Default `true`. The wire name is snake_case, unlike the other fields.
   */
  retain_body?: boolean;
}

/** Write-method options that every resource mutation accepts. */
export interface WriteOptions {
  /**
   * Optional idempotency key. When set, the SDK forwards it as the
   * `Idempotency-Key` header AND flips the fetcher into idempotent mode so
   * that 5xx responses are retried. Without a key the SDK will NOT retry 5xx
   * on write methods (to avoid double-sending an email if the service times
   * out after the SMTP handoff).
   */
  idempotencyKey?: string;
  /** Caller-supplied abort signal; cancels the in-flight request. */
  signal?: AbortSignal;
}

export interface SendEmailResponse {
  id: string;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | string;
}

export interface Email {
  id: string;
  appId: string;
  domainId: string;
  apiKeyId: string;
  idempotencyKey: string | null;
  messageId: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[] | null;
  bccAddresses: string[] | null;
  replyTo: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  attachmentsCount: number | null;
  status: string;
  failureReason: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListEmailsRequest {
  limit?: number;
  offset?: number;
}

export interface ListEmailsResponse {
  emails: Email[];
  limit: number;
  offset: number;
}

export interface GetEmailResponse {
  email: Email;
}
