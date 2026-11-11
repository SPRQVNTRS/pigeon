export interface PigeonApp {
  id: string;
  name: string;
  createdAt: string;
}

export interface PigeonApiKey {
  id: string;
  appId: string;
  name: string;
  prefix: string;
}

/**
 * One row of GET /v1/admin/api-keys. The server sends a fixed public field
 * list (never the key hash); the CLI reads these fields only and never prints
 * the row.
 */
export interface PigeonApiKeyListItem {
  id: string;
  appId: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
}

export interface PigeonAudience {
  id: string;
  appId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PigeonDomain {
  id: string;
  name: string;
  region: string;
  dkimTokens: string[];
  spfStatus: string;
  dkimStatus: string;
  dmarcStatus: string;
  mxStatus: string;
  verifiedAt: string | null;
}

export interface PigeonDnsRecord {
  type: string;
  host: string;
  value: string;
  ttl: number;
  priority?: number;
  notes?: string;
}

export interface PigeonDomainRegisterResponse {
  id: string;
  domain: PigeonDomain;
  dnsRecords: PigeonDnsRecord[];
}

export interface PigeonDomainGetResponse {
  domain: PigeonDomain;
  dnsRecords: PigeonDnsRecord[];
}

export interface PigeonDomainListResponse {
  domains: PigeonDomain[];
}

export interface PigeonDomainVerifyResponse {
  success: boolean;
  domainId: string;
}

export interface PigeonWebhook {
  id: string;
  appId: string;
  url: string;
  eventTypes: string[] | null;
  enabled: boolean | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create and rotate responses. The signing secret is shown once. */
export interface PigeonWebhookWithSecret {
  webhook: PigeonWebhook;
  signingSecret: string;
}

/** An inbound domain: SES receives mail for it and pigeon sends `email.received`. */
export interface PigeonInboundDomain {
  id: string;
  appId: string;
  name: string;
  region: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One received mail. Ids and counts only: no sender, subject, body or address. */
export interface PigeonInboundEmailSummary {
  id: string;
  inboundDomainId: string;
  receivedAt: string;
  recipientCount: number;
  createdAt: string;
}

export interface PigeonInboundReplay {
  inboundEmailId: string;
  jobId: string;
}
