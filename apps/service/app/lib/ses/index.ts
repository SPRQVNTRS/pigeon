/**
 * SES library barrel export
 */

export { getSesClient, resetSesClients } from './client';
export { createIdentity, getIdentity, deleteIdentity } from './identity';
export type { DkimAttributes, IdentityInfo, CreateIdentityResult } from './identity';
export { sendEmail } from './send';
export type { SendEmailOptions, SendEmailResult, Attachment } from './send';
export { buildDnsRecords } from './dns';
export type { DnsRecord, DnsRecordType, BuildDnsRecordsOptions } from './dns';
