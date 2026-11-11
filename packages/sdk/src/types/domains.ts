/**
 * DTOs for the `/v1/domains` endpoints.
 * Mirrors `apps/service/app/routes/api.v1.domains*.tsx`.
 */

export interface CreateDomainRequest {
  name: string;
  region?: string;
}

export type VerificationStatus = 'pending' | 'verified' | 'failed' | string;

export interface Domain {
  id: string;
  appId: string;
  name: string;
  region: string | null;
  dkimSelector: string | null;
  dkimTokens: string[] | null;
  spfStatus: VerificationStatus;
  dkimStatus: VerificationStatus;
  dmarcStatus: VerificationStatus;
  mxStatus: VerificationStatus;
  verifiedAt: string | null;
  lastVerificationError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DnsRecordType = 'CNAME' | 'TXT' | 'MX' | string;

export interface DnsRecord {
  type: DnsRecordType;
  host: string;
  value: string;
  priority?: number;
  ttl?: number;
  notes?: string;
}

export interface CreateDomainResponse {
  id: string;
  domain: Domain;
  dnsRecords: DnsRecord[];
}

export interface GetDomainResponse {
  domain: Domain;
  dnsRecords: DnsRecord[];
}

export interface ListDomainsResponse {
  domains: Domain[];
}

export interface VerifyDomainResponse {
  success: true;
  domainId: string;
}

export interface DeleteDomainResponse {
  success: true;
}
