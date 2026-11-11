import type { InboundDomain } from '#app/models/inbound-domains.server';

/** Explicit pick of the inbound domain fields the admin API exposes. */
export interface PublicInboundDomain {
  id: string;
  appId: string;
  name: string;
  region: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicInboundDomain(domain: InboundDomain): PublicInboundDomain {
  return {
    id: domain.id,
    appId: domain.appId,
    name: domain.name,
    region: domain.region,
    enabled: domain.enabled,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}
